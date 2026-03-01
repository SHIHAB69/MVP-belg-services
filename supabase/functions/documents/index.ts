// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isValidUUID(s: string): boolean {
  return typeof s === 'string' && s.length === 36 && UUID_REGEX.test(s.trim())
}

// Map currency code to display symbol (for showing sign instead of "CAD", "USD", etc.)
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  CAD: 'C$',
  AUD: 'A$',
  JPY: '¥',
  CHF: 'Fr',
  CNY: '¥',
  INR: '₹',
  BRL: 'R$',
  MXN: '$',
  KRW: '₩',
  RUB: '₽',
  ZAR: 'R',
}
function currencyToSymbol(code: string | null): string {
  if (!code || typeof code !== 'string') return '$'
  const upper = code.trim().toUpperCase()
  return CURRENCY_SYMBOLS[upper] ?? upper + ' '
}

Deno.serve(async (req) => {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const url = new URL(req.url)
    const user_id_param = url.searchParams.get('user_id') ?? ''
    const user_id = user_id_param.trim()

    if (req.method === 'DELETE') {
      let docId = (url.searchParams.get('id') ?? url.searchParams.get('document_id') ?? '').trim()
      if (!docId) {
        const body = await req.json().catch(() => ({})) as { id?: string; document_id?: string }
        docId = (body?.id ?? body?.document_id ?? '').trim()
      }

      if (!user_id || !isValidUUID(user_id)) {
        return new Response(JSON.stringify({ error: 'Missing or invalid user_id (must be a valid UUID)' }), {
          headers: { 'Content-Type': 'application/json' },
          status: 400,
        })
      }
      if (!docId || !isValidUUID(docId)) {
        return new Response(JSON.stringify({ error: 'Missing or invalid document id (use query id= or document_id=, or JSON body)' }), {
          headers: { 'Content-Type': 'application/json' },
          status: 400,
        })
      }

      const { data: doc, error: fetchErr } = await supabase
        .from('documents')
        .select('id, file_path')
        .eq('id', docId)
        .eq('user_id', user_id)
        .single()

      if (fetchErr || !doc) {
        return new Response(JSON.stringify({ error: 'Document not found or not owned by user' }), {
          headers: { 'Content-Type': 'application/json' },
          status: 404,
        })
      }

      const filePath = (doc as { file_path: string }).file_path
      if (filePath) {
        await supabase.storage.from('documents').remove([filePath])
      }

      const { error: deleteErr } = await supabase.from('documents').delete().eq('id', docId).eq('user_id', user_id)

      if (deleteErr) {
        console.error('documents delete error:', deleteErr)
        return new Response(JSON.stringify({ error: 'Failed to delete document' }), {
          headers: { 'Content-Type': 'application/json' },
          status: 500,
        })
      }

      return new Response(JSON.stringify({ deleted: true }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    if (req.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 405,
      })
    }

    let limit = DEFAULT_LIMIT
    const limitParam = url.searchParams.get('limit')
    if (limitParam !== null) {
      const n = parseInt(limitParam, 10)
      if (!isNaN(n) && n >= 1 && n <= MAX_LIMIT) limit = n
    }

    if (!user_id || !isValidUUID(user_id)) {
      return new Response(JSON.stringify({ error: 'Missing or invalid user_id (must be a valid UUID)' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 400,
      })
    }

    const { data: docs, error } = await supabase
      .from('documents')
      .select(
        'id, file_path, file_url, mime_type, file_size, created_at, ai_summary, transactions(amount, currency, merchant, category, transaction_date, city, country)'
      )
      .eq('user_id', user_id)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) {
      console.error('documents list error:', error)
      return new Response(JSON.stringify({ error: 'Failed to load documents' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 500,
      })
    }

    const emptyTransaction = {
      amount: null as number | null,
      currency: 'USD',
      currency_symbol: '$',
      merchant: null as string | null,
      category: null as string | null,
      transaction_date: null as string | null,
      city: null as string | null,
      country: null as string | null,
    }

    const documents = (docs ?? []).map((d: { transactions?: unknown }) => {
      const raw = d.transactions
      const tx =
        raw == null
          ? null
          : Array.isArray(raw) && raw.length > 0
            ? raw[0]
            : typeof raw === 'object' && raw !== null && 'amount' in (raw as object)
              ? raw
              : null
      const { transactions: _, ai_summary: docAiSummary, ...meta } = d as { transactions?: unknown; ai_summary?: string | null; [k: string]: unknown }
      const ai_summary = (docAiSummary != null && String(docAiSummary).trim() !== '') ? String(docAiSummary).trim() : null
      // transaction_date from transactions table = actual receipt/transaction date (not document upload date)
      const receiptDate = tx != null ? ((tx as { transaction_date: string | null }).transaction_date ?? null) : null
      const currencyCode = (tx as { currency: string | null })?.currency ?? 'USD'
      const transaction = tx != null
        ? {
            amount: Number((tx as { amount: string }).amount),
            currency: currencyCode,
            currency_symbol: currencyToSymbol(currencyCode),
            merchant: (tx as { merchant: string | null }).merchant ?? null,
            category: (tx as { category: string | null }).category ?? null,
            transaction_date: receiptDate,
            city: (tx as { city: string | null }).city ?? null,
            country: (tx as { country: string | null }).country ?? null,
          }
        : { ...emptyTransaction }
      return {
        ...meta,
        ai_summary,
        transaction_date: receiptDate,
        transaction,
      }
    })

    return new Response(JSON.stringify({ documents }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, no-store',
      },
      status: 200,
    })
  } catch (error) {
    console.error('documents error:', error)
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed to load documents',
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})
