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
  amount: number | null          // total (net + tax), after discounts
  net_amount: number | null
  tax_amount: number | null
  discount_amount: number        // 0 if no discount
  paid_amount: number | null
  currency: string | null
  merchant: string | null
  document_type: string | null   // "receipt" | "invoice" | "other"
  address: string | null
  category: string | null
  description: string | null
  transaction_date: string | null
  city: string | null
  country: string | null
  payment_method: string | null
  payment_status: string | null
  line_items: Array<{
    quantity: number
    product_name: string
    unit_price: number
    total_price: number
  }>
}

const EXTRACTION_SYSTEM = `You are a receipt/document extraction system. Extract all fields with maximum accuracy from the document.

Output: Reply with ONLY a single JSON object with these exact keys. No commentary. Use null for any field that is truly not present or unreadable.

- full_text: Transcribe ALL visible text from the document in order. Preserve line breaks. Include every line item, price, total, date, store name, address. Do not summarize or omit. Use exact characters as shown on the document.
- document_type: Exactly one of "receipt", "invoice", "other". receipt = issued by merchant at/shortly after purchase with ≥1 line item. invoice = issued by seller requesting payment with a unique invoice number and payment terms. other = anything else.
- merchant: The commercial name as perceived by the end user. For physical shops: the specific shop name. For web purchases: brand or webshop name. For invoices: legal entity name on the invoice.
- address: The address where goods/services were bought or the issuer's address. One line of text. null if not present.
- city: City of purchase or issuer (e.g. GENT, Brussels, San Francisco). null if not present.
- country: Country of purchase or issuer (e.g. Belgium, USA). null if not present.
- currency: ISO 4217 code (e.g. EUR, USD, GBP). Belgium/Netherlands/France/Germany/Spain/Italy → EUR. UK → GBP. US → USD. Canada → CAD. null if not determinable.
- transaction_date: The date the document was issued (NOT the upload date, NOT the payment date). Format as ISO 8601. Include time if present on the document (e.g. "2026-03-05T14:30:00"), otherwise date only (e.g. "2026-03-05"). Convert formats: 19/01/20 → 2020-01-19, 28-02-2026 → 2026-02-28.
- net_amount: Total for all goods/services BEFORE tax, after discounts, excluding already-paid amounts. Decimal with dot separator. null if not determinable.
- tax_amount: Total tax (VAT) on all goods/services, after discounts, excluding already-paid amounts. null if not determinable.
- amount: Total amount to be paid (net + tax), after discounts, excluding already-paid amounts. This is the main total/TOTAL/BETALING line. Convert to decimal with dot separator (e.g. 173,87 → 173.87).
- discount_amount: Total discount across all items. Use 0 if no discount is present — never null.
- paid_amount: Amount already paid on this document. null if not determinable or not applicable.
- payment_method: Exactly one of "cash", "debit_card", "credit_card", "mobile_payment", "bank_transfer", "not_paid", "other". null if not determinable.
- payment_status: Exactly one of "completed", "not_paid", "other". null if not determinable.
- category: One short label (e.g. Groceries, Restaurant, Electronics, Travel). No amount in category.
- description: Optional short description of what was bought (e.g. "Groceries and household items"). null if not useful.
- line_items: Array of all products/services on the document reflected in the total price. Each item: { "quantity": number, "product_name": string, "unit_price": number, "total_price": number }. unit_price = price for 1 unit including tax and any discount for that item. total_price = quantity × unit_price. Use empty array [] if no line items are present.
- ai_summary: Any relevant information about this document NOT captured in the fields above. null if nothing to add.`

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
      const s = v.trim()
      // Accept ISO 8601 date (YYYY-MM-DD) or datetime (YYYY-MM-DDThh:mm or YYYY-MM-DDThh:mm:ss) as-is
      if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(s)) return s
      const d = new Date(s)
      return isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, '')
    }

    // Parse line_items array safely
    const rawLineItems = parsed.line_items
    const lineItems: Array<{ quantity: number; product_name: string; unit_price: number; total_price: number }> =
      Array.isArray(rawLineItems)
        ? rawLineItems
            .map((item: unknown) => {
              if (typeof item !== 'object' || item === null) return null
              const i = item as Record<string, unknown>
              const q = num(i.quantity)
              const pn = str(i.product_name, 500)
              const up = num(i.unit_price)
              const tp = num(i.total_price)
              if (q === null || !pn || up === null || tp === null) return null
              return { quantity: q, product_name: pn, unit_price: up, total_price: tp }
            })
            .filter((i): i is { quantity: number; product_name: string; unit_price: number; total_price: number } => i !== null)
        : []

    return {
      full_text: str(parsed.full_text, 10000) ?? '',
      ai_summary: str(parsed.ai_summary, 1000),
      amount: num(parsed.amount),
      net_amount: num(parsed.net_amount),
      tax_amount: num(parsed.tax_amount),
      discount_amount: num(parsed.discount_amount) ?? 0,
      paid_amount: num(parsed.paid_amount),
      currency: str(parsed.currency, 10),
      merchant: str(parsed.merchant, 200),
      document_type: str(parsed.document_type, 50),
      address: str(parsed.address, 500),
      category: str(parsed.category, 100),
      description: str(parsed.description, 500),
      transaction_date: dateStr(parsed.transaction_date),
      city: str(parsed.city, 100),
      country: str(parsed.country, 100),
      payment_method: str(parsed.payment_method, 50),
      payment_status: str(parsed.payment_status, 50),
      line_items: lineItems,
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
        extraction_status: 'pending',         // explicit; column DEFAULT would set this anyway
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

    // ----------------------------------------------------------------------
    // Database fan-out (atomic via stored procedure).
    // ----------------------------------------------------------------------
    // The upload_extraction_fan_out() function (see m2_11 migration) wraps
    // the UPDATE documents + store/payment_method lookup-or-insert + subtype
    // INSERT + transaction INSERT + line_items expansion in a single Postgres
    // transaction. Any failure inside rolls back atomically; we then mark the
    // document 'failed' (separate write) so M3 re-extraction knows to retry it.
    //
    // Pre-extraction documents row already exists with extraction_status='pending'
    // (set by the INSERT above). The function flips it to 'completed' on success.
    let transactionCreated = false
    let aiSummaryStored = false

    if (extracted) {
      const { data: rpcData, error: rpcError } = await supabase.rpc('upload_extraction_fan_out', {
        p_document_id:      documentId,
        p_user_id:          userId,
        p_full_text:        extracted.full_text,
        p_ai_summary:       extracted.ai_summary,
        p_document_type:    extracted.document_type,
        p_amount:           extracted.amount,
        p_net_amount:       extracted.net_amount,
        p_tax_amount:       extracted.tax_amount,
        p_discount_amount:  extracted.discount_amount,
        p_paid_amount:      extracted.paid_amount,
        p_currency:         extracted.currency ?? 'EUR',
        p_merchant:         extracted.merchant,
        p_address:          extracted.address,
        p_city:             extracted.city,
        p_country:          extracted.country,
        p_category:         extracted.category,
        p_description:      extracted.description,
        p_transaction_date: extracted.transaction_date,
        p_payment_method:   extracted.payment_method,
        p_payment_status:   extracted.payment_status,
        p_line_items:       extracted.line_items,
      })

      if (rpcError) {
        // Fan-out rolled back atomically inside the function. Flip the
        // document to 'failed' so M3 re-extraction targets it. This UPDATE
        // is a separate (non-atomic) write -- if it also fails, the document
        // stays in 'pending' state and M3 can still detect/retry.
        await supabase.from('documents')
          .update({ extraction_status: 'failed' })
          .eq('id', documentId)
        await logError(
          supabase, documentId, userId,
          'FAN_OUT_FAILED',
          rpcError.message,
          undefined,
          { hasLineItems: extracted.line_items.length > 0, hasAmount: extracted.amount !== null }
        )
      } else {
        const row = Array.isArray(rpcData) && rpcData.length > 0 ? rpcData[0] : null
        transactionCreated = row?.transaction_created === true
        aiSummaryStored    = row?.ai_summary_stored === true
      }
    } else {
      // GPT-4o returned nothing usable. Mark document failed and log.
      await supabase.from('documents')
        .update({ extraction_status: 'failed' })
        .eq('id', documentId)
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
