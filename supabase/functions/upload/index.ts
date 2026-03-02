// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

// Safe base64 encoder that works for any file size.
// The spread-based btoa(String.fromCharCode(...bytes)) overflows the call
// stack for large files (phone photos > ~500 KB), silently breaking extraction.
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

// Structured extraction result from OpenAI vision.
type ExtractedReceipt = {
  full_text: string
  ai_summary: string | null
  amount: number | null
  currency: string | null
  merchant: string | null
  category: string | null
  description: string | null
  transaction_date: string | null
  city: string | null
  country: string | null
}

const EXTRACTION_SYSTEM = `You are a receipt/document extraction system. Your goal is to extract information with maximum accuracy (match exactly what is on the document).

Rules:
- full_text: Transcribe ALL visible text from the receipt/document in order. Preserve line breaks. Include every line item, price, total, date, store name, address. Do not summarize or omit. Use the exact characters (numbers, commas, dots) as shown. For European receipts use comma as decimal separator in the text if that is what is printed (e.g. 173,87).
- amount: The final total amount paid (the main total/totaal/TOTAL/BETALING line). Convert to a number with a dot for decimals (e.g. 173.87). If the receipt shows 173,87 or 173.87 use 173.87. Only the final paid total, not subtotals or line items.
- currency: From the document (e.g. EUR, €, USD). Belgium/Netherlands/France/Germany/Spain/Italy → EUR. UK → GBP. US → USD. Canada → CAD.
- transaction_date: The date on the receipt (sale or payment date). Convert to YYYY-MM-DD (e.g. 19/01/20 → 2020-01-19, 28-02-2026 → 2026-02-28).
- merchant: The exact store or business name as printed (e.g. AD DOK NOORD, Best Buy). First line of the receipt or the clear store name.
- city: From the address if present (e.g. GENT, Brussels). One word or short phrase.
- country: From the address or infer from context (e.g. Belgium, Netherlands, USA).
- category: One short label (e.g. Groceries, Supermarket, Electronics, Restaurant). No amount in category.
- ai_summary: One short label for the type of receipt (e.g. Groceries, Supermarket). Must NOT include amount or currency.
- description: Optional short description of what was bought (e.g. "Groceries and household items"); or null. Do not put the full item list here.

Output: Reply with ONLY a single JSON object with these exact keys: full_text, ai_summary, amount, currency, merchant, category, description, transaction_date, city, country. No commentary. If something is truly unreadable or missing, use null for that field only.`

// Upload a file to the OpenAI Files API.
// Returns the file_id on success, or null on failure.
async function uploadToOpenAIFiles(file: File, apiKey: string): Promise<string | null> {
  try {
    const form = new FormData()
    form.set('file', file, file.name || 'receipt.pdf')
    form.set('purpose', 'user_data')
    const response = await fetch('https://api.openai.com/v1/files', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: form,
    })
    if (!response.ok) {
      console.error('upload: OpenAI Files API error', response.status, await response.text())
      return null
    }
    const data = await response.json()
    return typeof data.id === 'string' ? data.id : null
  } catch (e) {
    console.error('upload: uploadToOpenAIFiles error', e)
    return null
  }
}

// Delete a file from the OpenAI Files API after extraction (best-effort cleanup).
async function deleteOpenAIFile(fileId: string, apiKey: string): Promise<void> {
  try {
    await fetch(`https://api.openai.com/v1/files/${fileId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    })
  } catch { /* best-effort */ }
}

// Convert PDF to PNG images via ConvertAPI (fallback if Files API is unavailable).
// Returns base64 data URLs for each page, or an empty array.
async function convertPdfToImages(file: File): Promise<string[]> {
  const apiUrl = Deno.env.get('PDF_CONVERT_API_URL')?.trim()
  const apiKey = Deno.env.get('PDF_CONVERT_API_KEY')?.trim() || Deno.env.get('PDF_CONVERT_API_SECRET')?.trim()
  if (!apiUrl || !apiKey) return []
  try {
    const form = new FormData()
    form.set('File', file)
    const url = new URL(apiUrl)
    url.searchParams.set('Secret', apiKey)
    const response = await fetch(url.toString(), { method: 'POST', body: form })
    if (!response.ok) return []
    const data = (await response.json()) as { Files?: Array<{ FileData?: string; Url?: string }>; images?: string[] }
    const out: string[] = []
    if (Array.isArray(data.Files)) {
      for (const f of data.Files) {
        if (f.FileData) {
          out.push(`data:image/png;base64,${f.FileData}`)
        } else if (f.Url) {
          const imgRes = await fetch(f.Url)
          if (imgRes.ok) {
            const buf = await imgRes.arrayBuffer()
            out.push(`data:image/png;base64,${toBase64(buf)}`)
          }
        }
      }
    } else if (Array.isArray(data.images)) {
      for (const b64 of data.images) {
        if (typeof b64 === 'string' && b64) out.push(b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`)
      }
    }
    return out
  } catch {
    return []
  }
}

// Send the document to OpenAI and return structured receipt fields.
//
// Priority order for PDFs:
//   1. openAiFileId — native PDF reading via Files API (best, mirrors ChatGPT behaviour)
//   2. pdfImageDataUrls — pages rendered to PNG via ConvertAPI (good fallback)
//
// For images the file is sent directly as a high-detail base64 image_url.
//
// Client-side OCR text is intentionally NOT sent — it introduces noise that
// degrades accuracy. The model's vision always reads the document cleanly.
async function extractWithOpenAI(
  file: File | null,
  openAiFileId: string | null,
  pdfImageDataUrls: string[],
): Promise<ExtractedReceipt | null> {
  const openaiApiKey = Deno.env.get('OPENAI_API_KEY')
  if (!openaiApiKey) return null

  const isImage = file != null && /^image\/(jpe?g|png|gif|webp)$/i.test(file.type?.toLowerCase() ?? '')
  const hasPdfFile = openAiFileId != null
  const hasPdfImages = pdfImageDataUrls.length > 0

  if (!isImage && !hasPdfFile && !hasPdfImages) return null

  try {
    const userContent: Array<unknown> = []

    if (isImage && file) {
      // Image: send directly at high detail — no OCR text to avoid noise
      userContent.push({ type: 'text', text: 'Extract all data from this receipt/document image.' })
      const buf = await file.arrayBuffer()
      const base64 = toBase64(buf)
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:${file.type || 'image/jpeg'};base64,${base64}`, detail: 'high' },
      })
    } else if (hasPdfFile) {
      // PDF via Files API — model reads the PDF natively, same as ChatGPT
      userContent.push({ type: 'text', text: 'Extract all data from this receipt/document.' })
      userContent.push({ type: 'file', file: { file_id: openAiFileId } })
    } else {
      // PDF converted to images via ConvertAPI
      userContent.push({ type: 'text', text: 'Extract all data from this receipt/document.' })
      for (const dataUrl of pdfImageDataUrls) {
        userContent.push({ type: 'image_url', image_url: { url: dataUrl, detail: 'high' } })
      }
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiApiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: EXTRACTION_SYSTEM },
          { role: 'user', content: userContent },
        ],
        max_tokens: 8192,
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    })

    if (!response.ok) {
      console.error('upload: OpenAI extraction failed', response.status, await response.text())
      return null
    }

    const data = await response.json()
    const raw = data.choices?.[0]?.message?.content?.trim()
    if (!raw) return null

    const parsed = JSON.parse(raw) as Record<string, unknown>

    const num = (v: unknown): number | null => {
      if (typeof v === 'number' && !Number.isNaN(v)) return v
      if (typeof v === 'string') {
        const n = parseFloat(v.trim().replace(',', '.'))
        return Number.isNaN(n) ? null : n
      }
      return null
    }
    const str = (v: unknown, max = 500): string | null =>
      typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
    const dateStr = (v: unknown): string | null => {
      if (typeof v !== 'string' || !v.trim()) return null
      if (/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return v.trim()
      const d = new Date(v.trim())
      return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0]
    }

    return {
      full_text: str(parsed.full_text, 10000) ?? '',
      ai_summary: str(parsed.ai_summary, 200),
      amount: num(parsed.amount),
      currency: str(parsed.currency, 10),
      merchant: str(parsed.merchant, 200),
      category: str(parsed.category, 100),
      description: str(parsed.description, 500),
      transaction_date: dateStr(parsed.transaction_date),
      city: str(parsed.city, 100),
      country: str(parsed.country, 100),
    }
  } catch (e) {
    console.error('upload: extractWithOpenAI error', e)
    return null
  }
}

// Log errors to the error_logs table without throwing.
async function logError(
  supabase: ReturnType<typeof createClient>,
  documentId: string | null,
  userId: string | null,
  errorType: string,
  errorMessage: string,
  stackTrace?: string,
  context?: Record<string, unknown>
) {
  try {
    await supabase.from('error_logs').insert({
      document_id: documentId,
      user_id: userId,
      error_type: errorType,
      error_message: errorMessage,
      stack_trace: stackTrace,
      context: context || null,
    })
  } catch { /* silently ignore */ }
}

Deno.serve(async (req) => {
  let documentId: string | null = null
  let userId: string | null = null

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)
    const openaiApiKey = Deno.env.get('OPENAI_API_KEY')

    const formData = await req.formData()
    const user_id = formData.get('user_id')?.toString()
    const file = formData.get('file') as File | null

    if (!user_id || !file) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: user_id or file' }),
        { headers: { 'Content-Type': 'application/json' }, status: 400 },
      )
    }

    const isImage = /^image\/(jpe?g|png|gif|webp)$/i.test(file.type?.toLowerCase() ?? '')
    const isPdf = file.type?.toLowerCase() === 'application/pdf'

    if (!isImage && !isPdf) {
      return new Response(
        JSON.stringify({ error: 'Only image (JPEG, PNG, GIF, WebP) and PDF files are supported.' }),
        { headers: { 'Content-Type': 'application/json' }, status: 400 },
      )
    }

    userId = user_id

    // Upload file to Supabase Storage
    const fileExt = file.name.split('.').pop() || 'bin'
    const filePath = `${user_id}/${crypto.randomUUID()}.${fileExt}`
    const fileArrayBuffer = await file.arrayBuffer()

    const { error: uploadError } = await supabase.storage
      .from('documents')
      .upload(filePath, fileArrayBuffer, {
        contentType: file.type || 'application/octet-stream',
        upsert: false,
      })

    if (uploadError) {
      await logError(supabase, null, userId, 'STORAGE_UPLOAD_ERROR', uploadError.message, undefined, { filePath })
      throw uploadError
    }

    const { data: urlData } = supabase.storage.from('documents').getPublicUrl(filePath)

    const { data: documentData, error: documentError } = await supabase
      .from('documents')
      .insert({
        user_id: userId,
        file_path: filePath,
        file_url: urlData.publicUrl,
        mime_type: file.type || null,
        file_size: file.size,
      })
      .select('id')
      .single()

    if (documentError) {
      await logError(supabase, null, userId, 'DOCUMENT_CREATE_ERROR', documentError.message, undefined, { filePath })
      throw documentError
    }

    documentId = documentData.id

    // For PDFs: upload to OpenAI Files API first (native PDF reading, same fidelity as ChatGPT).
    // If that fails, fall back to ConvertAPI image conversion.
    let openAiFileId: string | null = null
    let pdfImages: string[] = []

    if (isPdf && openaiApiKey) {
      openAiFileId = await uploadToOpenAIFiles(file, openaiApiKey)
      if (!openAiFileId) {
        console.warn('upload: Files API unavailable, falling back to ConvertAPI')
        pdfImages = await convertPdfToImages(file)
      }
    }

    // Extract structured data — no OCR text passed, vision reads the document directly
    const extracted = await extractWithOpenAI(
      isImage ? file : null,
      openAiFileId,
      pdfImages,
    )

    // Clean up the temporary OpenAI file immediately after extraction
    if (openAiFileId && openaiApiKey) {
      await deleteOpenAIFile(openAiFileId, openaiApiKey)
    }

    let transactionCreated = false
    let aiSummaryStored = false

    if (extracted) {
      // Save OCR/full text result
      const { error: ocrError } = await supabase.from('ocr_results').insert({
        document_id: documentId,
        raw_text: extracted.full_text || '',
        ocr_version: '2.0.0',
      })
      if (ocrError) {
        await logError(supabase, documentId, userId, 'OCR_SAVE_ERROR', ocrError.message, undefined, { rawTextLength: extracted.full_text?.length ?? 0 })
      }

      // Save AI summary to documents table
      if (extracted.ai_summary) {
        const { error: updateErr } = await supabase
          .from('documents')
          .update({ ai_summary: extracted.ai_summary })
          .eq('id', documentId)
        if (!updateErr) aiSummaryStored = true
        else await logError(supabase, documentId, userId, 'AI_SUMMARY_UPDATE_ERROR', updateErr.message)
      }

      // Create transaction only when OpenAI returned an amount
      if (extracted.amount !== null) {
        const { error: transactionError } = await supabase.from('transactions').insert({
          document_id: documentId,
          amount: extracted.amount,
          currency: extracted.currency ?? 'EUR',
          merchant: extracted.merchant,
          category: extracted.category,
          description: extracted.description,
          transaction_date: extracted.transaction_date,
          city: extracted.city,
          country: extracted.country,
          parser_version: '2.0.0',
          prompt_version: '2.0.0',
        })
        if (!transactionError) transactionCreated = true
        else await logError(supabase, documentId, userId, 'TRANSACTION_CREATE_ERROR', transactionError.message)
      }
    } else {
      await logError(supabase, documentId, userId, 'EXTRACTION_FAILED', 'OpenAI returned no data for this document')
    }

    return new Response(
      JSON.stringify({
        document_id: documentId,
        file_url: urlData.publicUrl,
        transaction_created: transactionCreated,
        ai_summary_generated: aiSummaryStored,
        ...(aiSummaryStored && extracted?.ai_summary ? { ai_summary: extracted.ai_summary } : {}),
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 201 },
    )
  } catch (error) {
    if (userId) {
      await logError(
        createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!),
        documentId,
        userId,
        'UPLOAD_FUNCTION_ERROR',
        error instanceof Error ? error.message : 'Unknown error',
        error instanceof Error ? error.stack : undefined,
      )
    }
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to process upload' }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 },
    )
  }
})
