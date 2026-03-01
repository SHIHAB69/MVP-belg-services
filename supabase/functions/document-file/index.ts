// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isValidUUID(s: string): boolean {
  return typeof s === 'string' && s.length === 36 && UUID_REGEX.test(s.trim())
}

/**
 * GET /document-file?user_id=...&id=...
 * Fetches the receipt/document file (image, PDF, etc.) for the Receipt section.
 * Returns the file bytes with correct Content-Type so the client can display it.
 */
Deno.serve(async (req) => {
  try {
    if (req.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 405,
      })
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const url = new URL(req.url)
    const user_id = (url.searchParams.get('user_id') ?? '').trim()
    const docId = (url.searchParams.get('id') ?? url.searchParams.get('document_id') ?? '').trim()

    if (!user_id || !isValidUUID(user_id)) {
      return new Response(JSON.stringify({ error: 'Missing or invalid user_id' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 400,
      })
    }
    if (!docId || !isValidUUID(docId)) {
      return new Response(JSON.stringify({ error: 'Missing or invalid document id (use id= or document_id=)' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 400,
      })
    }

    const { data: doc, error: fetchErr } = await supabase
      .from('documents')
      .select('id, file_path, mime_type')
      .eq('id', docId)
      .eq('user_id', user_id)
      .single()

    if (fetchErr || !doc) {
      return new Response(JSON.stringify({ error: 'Document not found or not owned by user' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 404,
      })
    }

    const file_path = (doc as { file_path: string }).file_path
    const mime_type = (doc as { mime_type: string | null }).mime_type ?? 'application/octet-stream'

    const { data: fileData, error: downloadErr } = await supabase.storage
      .from('documents')
      .download(file_path)

    if (downloadErr || !fileData) {
      console.error('document-file download error:', downloadErr)
      return new Response(JSON.stringify({ error: 'Failed to fetch file' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 500,
      })
    }

    const headers: Record<string, string> = {
      'Content-Type': mime_type,
      'Cache-Control': 'private, max-age=3600',
    }

    return new Response(fileData, {
      status: 200,
      headers,
    })
  } catch (error) {
    console.error('document-file error:', error)
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to fetch document file' }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})
