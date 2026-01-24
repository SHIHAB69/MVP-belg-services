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
} | null {
  try {
    // Extract amount - look for currency patterns like $10.50, 10.50, €10, etc.
    const amountMatch = rawText.match(/(?:[$€£¥]|USD|EUR|GBP)\s*(\d+(?:\.\d{2})?)|(\d+(?:\.\d{2})?)\s*(?:dollars?|USD|EUR|GBP)/i)
    const amount = amountMatch ? parseFloat(amountMatch[1] || amountMatch[2]) : null
    
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
    
    return {
      amount,
      currency,
      merchant,
      category,
      description,
      transaction_date
    }
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
    const raw_text = formData.get('raw_text')?.toString()
    const file = formData.get('file') as File | null

    if (!user_id || !raw_text || !file) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: user_id, raw_text, or file' }),
        { 
          headers: { "Content-Type": "application/json" },
          status: 400
        },
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

    // Save raw text in ocr_results
    const { error: ocrError } = await supabase
      .from('ocr_results')
      .insert({
        document_id: documentId,
        raw_text: raw_text,
        ocr_version: '1.0.0' // Default version, adjust as needed
      })

    if (ocrError) {
      await logError(supabase, documentId, userId, 'OCR_SAVE_ERROR', ocrError.message, undefined, { rawTextLength: raw_text.length })
      // Continue even if OCR save fails
    }

    // Best-effort parse and create transaction (never fail if parsing fails)
    const parsedData = parseTransaction(raw_text)
    
    if (parsedData && parsedData.amount !== null) {
      try {
        const { error: transactionError } = await supabase
          .from('transactions')
          .insert({
            document_id: documentId,
            amount: parsedData.amount,
            currency: parsedData.currency,
            merchant: parsedData.merchant,
            category: parsedData.category,
            description: parsedData.description,
            transaction_date: parsedData.transaction_date,
            parser_version: '1.0.0', // Default version, adjust as needed
            prompt_version: '1.0.0'  // Default version, adjust as needed
          })

        if (transactionError) {
          await logError(
            supabase,
            documentId,
            userId,
            'TRANSACTION_CREATE_ERROR',
            transactionError.message,
            undefined,
            { parsedData }
          )
          // Continue - don't fail the request
        }
      } catch (parseError) {
        await logError(
          supabase,
          documentId,
          userId,
          'TRANSACTION_PARSE_ERROR',
          parseError instanceof Error ? parseError.message : 'Unknown parsing error',
          parseError instanceof Error ? parseError.stack : undefined,
          { rawText: raw_text.substring(0, 500) }
        )
        // Continue - don't fail the request
      }
    } else {
      // Parsing failed but that's okay - log it and continue
      await logError(
        supabase,
        documentId,
        userId,
        'TRANSACTION_PARSE_FAILED',
        'Could not extract transaction data from raw text',
        undefined,
        { rawTextLength: raw_text.length }
      )
    }

    // Return success response
    return new Response(
      JSON.stringify({
        document_id: documentId,
        file_url: urlData.publicUrl,
        transaction_created: parsedData !== null && parsedData.amount !== null
      }),
      {
        headers: { "Content-Type": "application/json" },
        status: 201
      },
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
