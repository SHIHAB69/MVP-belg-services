// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

// Best-effort parser to extract transaction data from raw text
// Never throws - returns null if parsing fails
function parseTransaction(rawText: string): {
  amount: number | null
  currency: string
  merchant: string | null
  category: string | null
  description: string | null
  transaction_date: string | null
  city: string | null
  country: string | null
} | null {
  try {
    // Extract amount - try currency patterns first, then fallback to "total/amount 12.34" or plain "12.34"
    let amount: number | null = null
    const currencyPattern = /(?:[$€£¥]|USD|EUR|GBP)\s*(\d+(?:\.\d{2})?)|(\d+(?:\.\d{2})?)\s*(?:dollars?|USD|EUR|GBP)/i
    const totalPattern = /(?:total|amount|sum|balance|due)\s*[:=]?\s*(\d+(?:\.\d{2})?)/i
    const plainNumberPattern = /\b(\d{1,6}\.\d{2})\b/
    const m1 = rawText.match(currencyPattern)
    const m2 = rawText.match(totalPattern)
    const m3 = rawText.match(plainNumberPattern)
    if (m1) amount = parseFloat(m1[1] || m1[2])
    else if (m2) amount = parseFloat(m2[1])
    else if (m3) amount = parseFloat(m3[1])
    
    // Extract currency - default to USD
    const currencyMatch = rawText.match(/([$€£¥]|USD|EUR|GBP)/i)
    const currency = currencyMatch ? (currencyMatch[0].toUpperCase() === '$' ? 'USD' : currencyMatch[0].toUpperCase()) : 'USD'
    
    // Extract merchant - look for common merchant patterns
    const merchantMatch = rawText.match(/(?:at|from|merchant|store):?\s*([A-Z][A-Za-z\s&]+)/i)
    const merchant = merchantMatch ? merchantMatch[1].trim() : null
    
    // Extract date - look for date patterns
    const dateMatch = rawText.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})|(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})/)
    let transaction_date: string | null = null
    if (dateMatch) {
      try {
        const dateStr = dateMatch[1] || dateMatch[2]
        const date = new Date(dateStr)
        if (!isNaN(date.getTime())) {
          transaction_date = date.toISOString().split('T')[0]
        }
      } catch {
        // Ignore date parsing errors
      }
    }
    
    // If no amount found, return null (parsing failed)
    if (amount === null) {
      return null
    }
    
    // Extract description (first 200 chars of text)
    const description = rawText.substring(0, 200).trim() || null
    
    // Simple category extraction (could be enhanced)
    let category: string | null = null
    const categoryKeywords: Record<string, string> = {
      'food|restaurant|cafe|dining': 'Food',
      'gas|fuel|petrol': 'Transportation',
      'grocery|supermarket|store': 'Groceries',
      'coffee|starbucks': 'Food',
      'uber|taxi|ride': 'Transportation',
    }
    
    for (const [pattern, cat] of Object.entries(categoryKeywords)) {
      if (new RegExp(pattern, 'i').test(rawText)) {
        category = cat
        break
      }
    }
    
    // Extract city: "City Index - 12345", "123 Some St, Brussels", or line with comma then city name
    let city: string | null = null
    const cityIndexMatch = rawText.match(/(?:City|city)\s*(?:Index)?\s*[-:]\s*([A-Za-z0-9\s\-]+?)(?:\n|$|,)/i)
    const cityCommaMatch = rawText.match(/(?:,\s*)([A-Z][A-Za-z\s\-]{1,40})(?:\s*,|\s+\d{4,5}|$)/)
    if (cityIndexMatch) city = cityIndexMatch[1].trim().slice(0, 100)
    else if (cityCommaMatch) city = cityCommaMatch[1].trim().slice(0, 100)
    
    // Extract country: common names at end of address or standalone
    let country: string | null = null
    const countryNames = ['Belgium', 'France', 'Germany', 'Netherlands', 'USA', 'United States', 'UK', 'Spain', 'Italy']
    for (const name of countryNames) {
      if (new RegExp(`\\b${name.replace(/\s/g, '\\s')}\\b`, 'i').test(rawText)) {
        country = name
        break
      }
    }
    
    return {
      amount,
      currency,
      merchant,
      category,
      description,
      transaction_date,
      city,
      country,
    }
  } catch {
    return null
  }
}

// Generate a short, one-glance label from receipt/OCR text (e.g. "Groceries", "Supermarket").
// Must NOT include amount or currency—those are structured fields stored separately.
async function generateAiSummary(rawText: string): Promise<string | null> {
  const openaiApiKey = Deno.env.get('OPENAI_API_KEY')
  if (!openaiApiKey) {
    console.error('upload: OPENAI_API_KEY not set, skipping AI summary')
    return null
  }
  const trimmed = rawText?.trim() ?? ''
  if (trimmed.length === 0) return null
  try {
    const truncated = trimmed.slice(0, 3000)
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a receipt summarizer. Given raw OCR/receipt text, output a very short label so the user knows at a glance what the spending was about.

Rules:
- Do NOT include amount, price, total, or currency (no numbers, no $, €, USD, etc.). Amount and currency are stored as separate structured fields and must not be duplicated in the summary.
- Use 1-6 words. Prefer category or store/merchant type (e.g. "Groceries", "Supermarket", "Restaurant", "Coffee shop", "Pharmacy", "Gas station").
- Output ONLY that short label, nothing else. No punctuation at the end.`,
          },
          { role: 'user', content: truncated },
        ],
        max_tokens: 60,
        temperature: 0.2,
      }),
    })
    if (!response.ok) {
      const errText = await response.text()
      console.error('upload: OpenAI summary failed', response.status, errText)
      return null
    }
    const data = await response.json()
    const summary = data.choices?.[0]?.message?.content?.trim()
    return summary && summary.length > 0 ? summary : null
  } catch (e) {
    console.error('upload: AI summary error', e)
    return null
  }
}

// Extract city and country from receipt/OCR text via AI; stored in transactions table.
async function extractCityCountry(rawText: string): Promise<{ city: string | null; country: string | null }> {
  const openaiApiKey = Deno.env.get('OPENAI_API_KEY')
  if (!openaiApiKey || !rawText?.trim()) return { city: null, country: null }
  try {
    const truncated = rawText.trim().slice(0, 2000)
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiApiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'From receipt or invoice text, extract only the city and country of the merchant or transaction location. Reply with exactly a JSON object: {"city":"CityName"} or {"city":"CityName","country":"CountryName"} or {"country":"CountryName"}. Use null for missing values. One word or short phrase per field (e.g. "Brussels", "Belgium"). If nothing is found, reply: {}. No other text.',
          },
          { role: 'user', content: truncated },
        ],
        max_tokens: 80,
        temperature: 0.1,
      }),
    })
    if (!response.ok) return { city: null, country: null }
    const data = await response.json()
    const content = data.choices?.[0]?.message?.content?.trim()
    if (!content) return { city: null, country: null }
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return { city: null, country: null }
    const parsed = JSON.parse(jsonMatch[0]) as { city?: string; country?: string }
    const city = typeof parsed?.city === 'string' && parsed.city.trim() ? parsed.city.trim().slice(0, 100) : null
    const country = typeof parsed?.country === 'string' && parsed.country.trim() ? parsed.country.trim().slice(0, 100) : null
    return { city, country }
  } catch {
    return { city: null, country: null }
  }
}

// Structured extraction result from OpenAI (image + optional OCR text). Do not assume; use null when unclear.
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

const EXTRACTION_SYSTEM = `You are a receipt/document extraction system. Your goal is to extract information with maximum accuracy (match exactly what is on the document). Use both the image and any provided OCR text.

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

// Convert PDF to PNG images via external API. Set PDF_CONVERT_API_URL (e.g. https://v2.convertapi.com/convert/pdf/to/png) and PDF_CONVERT_API_KEY (Secret).
// Returns data URLs for each page; empty array if not configured or conversion fails.
async function convertPdfToImages(file: File): Promise<string[]> {
  const apiUrl = Deno.env.get('PDF_CONVERT_API_URL')?.trim()
  const apiKey = Deno.env.get('PDF_CONVERT_API_KEY')?.trim() || Deno.env.get('PDF_CONVERT_API_SECRET')?.trim()
  if (!apiUrl || !apiKey) return []
  try {
    const form = new FormData()
    form.set('File', file)
    const url = new URL(apiUrl)
    url.searchParams.set('Secret', apiKey)
    const response = await fetch(url.toString(), {
      method: 'POST',
      body: form,
    })
    if (!response.ok) return []
    const data = (await response.json()) as { Files?: Array<{ FileData?: string; Url?: string }>; images?: string[] }
    const out: string[] = []
    if (Array.isArray(data.Files)) {
      for (const f of data.Files) {
        if (f.FileData) {
          const b64 = typeof f.FileData === 'string' ? f.FileData : ''
          if (b64) out.push(`data:image/png;base64,${b64}`)
        } else if (f.Url) {
          const imgRes = await fetch(f.Url)
          if (imgRes.ok) {
            const buf = await imgRes.arrayBuffer()
            const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)))
            out.push(`data:image/png;base64,${b64}`)
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

// Sends image(s) and/or OCR text to OpenAI; returns structured fields. No guessing. Supports: single image file, PDF pages (as image data URLs), or text only.
async function extractWithOpenAI(
  file: File | null,
  pdfImageDataUrls: string[] | null,
  ocrText: string
): Promise<ExtractedReceipt | null> {
  const openaiApiKey = Deno.env.get('OPENAI_API_KEY')
  if (!openaiApiKey) return null
  const isImage = file && /^image\/(jpe?g|png|gif|webp)$/i.test(file.type?.toLowerCase() ?? '')
  const hasPdfImages = Array.isArray(pdfImageDataUrls) && pdfImageDataUrls.length > 0
  const hasVisual = isImage || hasPdfImages
  try {
    // Build user message content (images + text) separately from system instructions
    const userContent: Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }> = []

    // User message is ONLY the data — no instructions mixed in
    if (hasVisual && ocrText.trim()) {
      userContent.push({
        type: 'text',
        text: `Extract all data from this receipt/document. The IMAGE is the primary source of truth.\n\nOptional OCR text from client (use only to help read unclear parts of the image — if it contradicts the image, ignore it):\n\n${ocrText.trim()}`,
      })
    } else if (hasVisual) {
      userContent.push({ type: 'text', text: 'Extract all data from this receipt/document image.' })
    } else if (ocrText.trim()) {
      userContent.push({ type: 'text', text: `Extract all data from this receipt/document text. If something is unclear, use null.\n\n${ocrText.trim()}` })
    } else {
      return null
    }

    // Attach images
    const imageDetail = 'high' as const
    if (isImage && file) {
      const buf = await file.arrayBuffer()
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)))
      const mediaType = file.type || 'image/jpeg'
      userContent.push({ type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}`, detail: imageDetail } })
    } else if (hasPdfImages) {
      for (const dataUrl of pdfImageDataUrls!) {
        userContent.push({ type: 'image_url', image_url: { url: dataUrl, detail: imageDetail } })
      }
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiApiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          // System message: all instructions go here, separate from user data
          { role: 'system', content: EXTRACTION_SYSTEM },
          // User message: only the receipt data (text + images)
          { role: 'user', content: userContent },
        ],
        max_tokens: 8192,
        temperature: 0,
        // Force valid JSON output — prevents markdown fences, commentary, malformed JSON
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
    // With response_format: json_object, the response is guaranteed valid JSON
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const num = (v: unknown): number | null => {
      if (typeof v === 'number' && !Number.isNaN(v)) return v
      if (typeof v === 'string') {
        const normalized = v.trim().replace(',', '.')
        const n = parseFloat(normalized)
        return Number.isNaN(n) ? null : n
      }
      return null
    }
    const str = (v: unknown, max = 500): string | null =>
      typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
    const dateStr = (v: unknown): string | null => {
      if (typeof v !== 'string' || !v.trim()) return null
      // Handle YYYY-MM-DD directly first
      const isoMatch = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
      if (isoMatch) return v.trim()
      const d = new Date(v.trim())
      if (isNaN(d.getTime())) return null
      return d.toISOString().split('T')[0]
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

// Fallback: extract plain text from image only (used when extractWithOpenAI fails).
async function extractTextWithVision(file: File): Promise<string | null> {
  const openaiApiKey = Deno.env.get('OPENAI_API_KEY')
  if (!openaiApiKey) return null
  try {
    const buf = await file.arrayBuffer()
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)))
    const mediaType = file.type || 'image/jpeg'
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiApiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Extract all text from this receipt or document. Plain text only, no JSON.' },
              { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
            ],
          },
        ],
        max_tokens: 4096,
        temperature: 0.1,
      }),
    })
    if (!response.ok) return null
    const data = await response.json()
    return data.choices?.[0]?.message?.content?.trim() ?? null
  } catch {
    return null
  }
}

// Helper to log errors without failing the request
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
      context: context || null
    })
  } catch {
    // Silently fail error logging
  }
}

Deno.serve(async (req) => {
  let documentId: string | null = null
  let userId: string | null = null
  
  try {
    // Get Supabase client using service role key
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Parse multipart form data
    const formData = await req.formData()
    const user_id = formData.get('user_id')?.toString()
    const raw_text =
      formData.get('raw_text')?.toString() ??
      formData.get('extracted_text')?.toString() ??
      formData.get('ocr_text')?.toString() ??
      ''
    const file = formData.get('file') as File | null

    if (!user_id || !file) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: user_id or file' }),
        { headers: { 'Content-Type': 'application/json' }, status: 400 },
      )
    }
    const ocrText = (raw_text ?? '').trim()
    const isImage = /^image\/(jpe?g|png|gif|webp)$/i.test(file.type?.toLowerCase() ?? '')
    const isPdf = file.type?.toLowerCase() === 'application/pdf'
    if (!isImage && !isPdf && ocrText.length === 0) {
      return new Response(
        JSON.stringify({
          error: 'For non-image, non-PDF files send raw_text, extracted_text, or ocr_text. For images and PDFs you can also send OCR text; we use both document and text for higher accuracy.',
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 400 },
      )
    }

    userId = user_id

    // Generate unique file path
    const fileExt = file.name.split('.').pop() || 'bin'
    const fileName = `${crypto.randomUUID()}.${fileExt}`
    const filePath = `${user_id}/${fileName}`

    // Upload file to Supabase Storage
    // Assuming bucket name is 'documents' - adjust if needed
    const fileArrayBuffer = await file.arrayBuffer()
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('documents')
      .upload(filePath, fileArrayBuffer, {
        contentType: file.type || 'application/octet-stream',
        upsert: false
      })

    if (uploadError) {
      await logError(supabase, null, userId, 'STORAGE_UPLOAD_ERROR', uploadError.message, undefined, { filePath })
      throw uploadError
    }

    // Get public URL for the file
    const { data: urlData } = supabase.storage
      .from('documents')
      .getPublicUrl(filePath)

    // Create document record
    const { data: documentData, error: documentError } = await supabase
      .from('documents')
      .insert({
        user_id: userId,
        file_path: filePath,
        file_url: urlData.publicUrl,
        mime_type: file.type || null,
        file_size: file.size
      })
      .select('id')
      .single()

    if (documentError) {
      await logError(supabase, null, userId, 'DOCUMENT_CREATE_ERROR', documentError.message, undefined, { filePath })
      throw documentError
    }

    documentId = documentData.id

    const pdfImages = isPdf ? await convertPdfToImages(file) : []
    if (isPdf && pdfImages.length === 0 && ocrText.length === 0) {
      return new Response(
        JSON.stringify({
          error: 'For PDF either set PDF_CONVERT_API_URL and PDF_CONVERT_API_KEY (e.g. ConvertAPI) so we can convert pages to images, or send raw_text/extracted_text/ocr_text with the file.',
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 400 },
      )
    }
    const extracted = await extractWithOpenAI(
      isImage ? file : null,
      isPdf && pdfImages.length > 0 ? pdfImages : null,
      ocrText
    )
    let textToUse: string
    let aiSummary: string | null = null
    let aiSummaryStored = false
    let transactionCreated = false
    let parsedAmount: number | null = null
    let parsedCurrency: string | null = null
    let parsedMerchant: string | null = null
    let parsedCategory: string | null = null
    let parsedDescription: string | null = null
    let parsedDate: string | null = null
    let parsedCity: string | null = null
    let parsedCountry: string | null = null

    if (extracted) {
      textToUse = extracted.full_text || ocrText || ''
      aiSummary = extracted.ai_summary
      if (extracted.amount !== null) {
        parsedAmount = extracted.amount
        parsedCurrency = extracted.currency ?? null
        parsedMerchant = extracted.merchant ?? null
        parsedCategory = extracted.category ?? null
        parsedDescription = extracted.description ?? null
        parsedDate = extracted.transaction_date ?? null
        parsedCity = extracted.city ?? null
        parsedCountry = extracted.country ?? null
      }
    } else {
      if (isImage && ocrText.length === 0) {
        const visionText = await extractTextWithVision(file)
        textToUse = (visionText ?? '').trim()
      } else {
        textToUse = ocrText || (isImage ? ((await extractTextWithVision(file)) ?? '').trim() : '')
      }
      if (textToUse.length === 0) {
        await logError(supabase, documentId, userId, 'EXTRACTION_FAILED', 'No text from OpenAI or fallback', undefined, undefined)
        return new Response(
          JSON.stringify({ error: 'Could not extract document content. Try again or send OCR text with the file.' }),
          { headers: { 'Content-Type': 'application/json' }, status: 422 }
        )
      }
      aiSummary = await generateAiSummary(textToUse)
      const parsedData = parseTransaction(textToUse)
      const { city: aiCity, country: aiCountry } = await extractCityCountry(textToUse)
      if (parsedData && parsedData.amount !== null) {
        parsedAmount = parsedData.amount
        parsedCurrency = parsedData.currency
        parsedMerchant = parsedData.merchant
        parsedCategory = parsedData.category
        parsedDescription = parsedData.description
        parsedDate = parsedData.transaction_date
        parsedCity = aiCity ?? parsedData.city ?? null
        parsedCountry = aiCountry ?? parsedData.country ?? null
      }
    }

    const { error: ocrError } = await supabase
      .from('ocr_results')
      .insert({
        document_id: documentId,
        raw_text: textToUse,
        ocr_version: '1.0.0',
      })
    if (ocrError) {
      await logError(supabase, documentId, userId, 'OCR_SAVE_ERROR', ocrError.message, undefined, { rawTextLength: textToUse.length })
    }

    if (aiSummary) {
      const { error: updateErr } = await supabase.from('documents').update({ ai_summary: aiSummary }).eq('id', documentId)
      if (!updateErr) aiSummaryStored = true
      else await logError(supabase, documentId, userId, 'AI_SUMMARY_UPDATE_ERROR', updateErr.message, undefined, { hint: 'Ensure documents.ai_summary column exists' })
    }

    if (parsedAmount !== null) {
      const { error: transactionError } = await supabase
        .from('transactions')
        .insert({
          document_id: documentId,
          amount: parsedAmount,
          currency: parsedCurrency ?? 'USD',
          merchant: parsedMerchant,
          category: parsedCategory,
          description: parsedDescription,
          transaction_date: parsedDate,
          city: parsedCity,
          country: parsedCountry,
          parser_version: '1.0.0',
          prompt_version: '1.0.0',
        })
      if (!transactionError) transactionCreated = true
      else await logError(supabase, documentId, userId, 'TRANSACTION_CREATE_ERROR', transactionError.message, undefined, undefined)
    }

    return new Response(
      JSON.stringify({
        document_id: documentId,
        file_url: urlData.publicUrl,
        transaction_created: transactionCreated,
        ai_summary_generated: aiSummaryStored,
        ...(aiSummaryStored && aiSummary ? { ai_summary: aiSummary } : {}),
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 201 },
    )
  } catch (error) {
    // Log the error
    if (userId) {
      await logError(
        createClient(
          Deno.env.get('SUPABASE_URL')!,
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
        ),
        documentId,
        userId,
        'UPLOAD_FUNCTION_ERROR',
        error instanceof Error ? error.message : 'Unknown error',
        error instanceof Error ? error.stack : undefined
      )
    }

    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed to process upload'
      }),
      {
        headers: { "Content-Type": "application/json" },
        status: 500
      },
    )
  }
})
