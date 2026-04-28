// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isValidUUID(s: string): boolean {
  return typeof s === 'string' && s.length === 36 && UUID_REGEX.test(s.trim())
}

// Map currency code to display symbol (unchanged from MVP).
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$', EUR: '€', GBP: '£', CAD: 'C$', AUD: 'A$',
  JPY: '¥', CHF: 'Fr', CNY: '¥', INR: '₹', BRL: 'R$',
  MXN: '$', KRW: '₩', RUB: '₽', ZAR: 'R',
}
function currencyToSymbol(code: string | null): string {
  if (!code || typeof code !== 'string') return '$'
  const upper = code.trim().toUpperCase()
  return CURRENCY_SYMBOLS[upper] ?? upper + ' '
}

// OCR convention reader: prefer human-edited *_corrected, fall back to extractor *_ocr.
function coalesceNum(corrected: unknown, ocr: unknown): number | null {
  const v = corrected ?? ocr
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isNaN(n) ? null : n
}
function coalesceStr(corrected: unknown, ocr: unknown): string | null {
  const v = corrected ?? ocr
  return (typeof v === 'string' && v.length > 0) ? v : null
}

Deno.serve(async (req) => {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const url = new URL(req.url)
    const user_id_param = url.searchParams.get('user_id') ?? ''
    const user_id = user_id_param.trim()

    // -------------------------------------------------------------------
    // DELETE
    // -------------------------------------------------------------------
    if (req.method === 'DELETE') {
      let docId = (url.searchParams.get('id') ?? url.searchParams.get('document_id') ?? '').trim()
      if (!docId) {
        const body = await req.json().catch(() => ({})) as { id?: string; document_id?: string }
        docId = (body?.id ?? body?.document_id ?? '').trim()
      }

      if (!user_id || !isValidUUID(user_id)) {
        return new Response(JSON.stringify({ error: 'Missing or invalid user_id (must be a valid UUID)' }), {
          headers: { 'Content-Type': 'application/json' }, status: 400,
        })
      }
      if (!docId || !isValidUUID(docId)) {
        return new Response(JSON.stringify({ error: 'Missing or invalid document id (use query id= or document_id=, or JSON body)' }), {
          headers: { 'Content-Type': 'application/json' }, status: 400,
        })
      }

      // Fetch the file path so we can clean up the storage object after the row delete.
      const { data: doc, error: fetchErr } = await supabase
        .from('documents')
        .select('id, file_path')
        .eq('id', docId)
        .eq('user_id', user_id)
        .single()

      if (fetchErr || !doc) {
        return new Response(JSON.stringify({ error: 'Document not found or not owned by user' }), {
          headers: { 'Content-Type': 'application/json' }, status: 404,
        })
      }

      const filePath = (doc as { file_path: string }).file_path
      if (filePath) {
        await supabase.storage.from('documents').remove([filePath])
      }

      // Schema-level CASCADE handles all the cleanup (per Decision 13):
      //   documents -> receipts        ON DELETE CASCADE
      //   documents -> invoices        ON DELETE CASCADE
      //   documents -> payslips        ON DELETE CASCADE
      //   documents -> bank_statements ON DELETE CASCADE
      //   documents -> cc_statements   ON DELETE CASCADE
      //   documents -> line_items      ON DELETE CASCADE
      //   documents -> transactions    ON DELETE CASCADE  (Decision 13 -- matches MVP)
      //   documents -> error_logs      ON DELETE SET NULL (forensic data outlives parents)
      // No manual cleanup needed; this matches MVP's CASCADE behavior and applies
      // uniformly to NocoDB deletes, manual SQL, and any other delete path.
      const { error: deleteErr } = await supabase.from('documents').delete().eq('id', docId).eq('user_id', user_id)

      if (deleteErr) {
        console.error('documents delete error:', deleteErr)
        return new Response(JSON.stringify({ error: 'Failed to delete document' }), {
          headers: { 'Content-Type': 'application/json' }, status: 500,
        })
      }

      return new Response(JSON.stringify({ deleted: true }), {
        headers: { 'Content-Type': 'application/json' }, status: 200,
      })
    }

    // -------------------------------------------------------------------
    // GET
    // -------------------------------------------------------------------
    if (req.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        headers: { 'Content-Type': 'application/json' }, status: 405,
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
        headers: { 'Content-Type': 'application/json' }, status: 400,
      })
    }

    // Rich JOIN matching the new schema. PostgREST nested embedding fetches
    // documents -> transactions/receipts/invoices/line_items in one round trip.
    // Sub-embeds: receipts -> stores; transactions -> payment_methods.
    const { data: docs, error } = await supabase
      .from('documents')
      .select(`
        id, file_path, file_url, mime_type, file_size, created_at,
        ai_summary_ocr, ai_summary_corrected,
        document_type_ocr, document_type_corrected,
        transactions (
          amount_ocr, amount_corrected,
          currency_ocr, currency_corrected,
          transaction_date_ocr, transaction_date_corrected,
          payment_methods (
            payment_type_ocr, payment_type_corrected
          )
        ),
        receipts (
          total_amount_ocr, total_amount_corrected,
          net_amount_ocr, net_amount_corrected,
          tax_amount_ocr, tax_amount_corrected,
          discount_amount_ocr, discount_amount_corrected,
          paid_amount_ocr, paid_amount_corrected,
          currency_ocr, currency_corrected,
          purchase_date_ocr, purchase_date_corrected,
          payment_status_ocr, payment_status_corrected,
          category_ocr, category_corrected,
          description_ocr, description_corrected,
          stores (
            name_ocr, name_corrected,
            address_ocr, address_corrected,
            city_name_ocr, country_name_ocr
          )
        ),
        invoices (
          total_amount_ocr, total_amount_corrected,
          net_amount_ocr, net_amount_corrected,
          tax_amount_ocr, tax_amount_corrected,
          discount_amount_ocr, discount_amount_corrected,
          paid_amount_ocr, paid_amount_corrected,
          currency_ocr, currency_corrected,
          payment_status_ocr, payment_status_corrected,
          category_ocr, category_corrected,
          description_ocr, description_corrected
        ),
        line_items (
          name_ocr, name_corrected,
          quantity_ocr, quantity_corrected,
          unit_price_ocr, unit_price_corrected,
          total_price_ocr, total_price_corrected,
          created_at
        )
      `)
      .eq('user_id', user_id)
      .order('created_at', { ascending: false })
      .order('created_at', { ascending: true, referencedTable: 'line_items' })
      .limit(limit)

    if (error) {
      console.error('documents list error:', error)
      return new Response(JSON.stringify({ error: 'Failed to load documents' }), {
        headers: { 'Content-Type': 'application/json' }, status: 500,
      })
    }

    // Empty transaction template (preserved verbatim from MVP for shape parity).
    const emptyTransaction = {
      amount: null as number | null,
      net_amount: null as number | null,
      tax_amount: null as number | null,
      discount_amount: null as number | null,
      paid_amount: null as number | null,
      currency: 'USD',
      currency_symbol: '$',
      merchant: null as string | null,
      document_type: null as string | null,
      address: null as string | null,
      category: null as string | null,
      description: null as string | null,
      transaction_date: null as string | null,
      city: null as string | null,
      country: null as string | null,
      payment_method: null as string | null,
      payment_status: null as string | null,
      line_items: [] as unknown[],
    }

    const documents = (docs ?? []).map((d: any) => {
      // Each embed could be a single object or an array depending on JS-client
      // version + cardinality. Normalize defensively.
      const tx = Array.isArray(d.transactions) ? (d.transactions[0] ?? null) : (d.transactions ?? null)
      const receipt = Array.isArray(d.receipts) ? (d.receipts[0] ?? null) : (d.receipts ?? null)
      const invoice = Array.isArray(d.invoices) ? (d.invoices[0] ?? null) : (d.invoices ?? null)
      const subtype = receipt ?? invoice
      const store = receipt?.stores ?? null                    // invoices have no store yet (Decision 14)
      const paymentMethod = tx?.payment_methods ?? null
      const lineItemRows = Array.isArray(d.line_items) ? d.line_items : []

      const ai_summary = coalesceStr(d.ai_summary_corrected, d.ai_summary_ocr)
      const document_type = coalesceStr(d.document_type_corrected, d.document_type_ocr)

      // Currency / date can come from either the transaction row or the subtype.
      const currencyCode = coalesceStr(tx?.currency_corrected, tx?.currency_ocr)
                        ?? coalesceStr(subtype?.currency_corrected, subtype?.currency_ocr)
                        ?? 'USD'
      const transaction_date = coalesceStr(tx?.transaction_date_corrected, tx?.transaction_date_ocr)
                            ?? coalesceStr(receipt?.purchase_date_corrected, receipt?.purchase_date_ocr)

      // Remap line_items rows to the MVP JSON shape (key 'product_name', not 'name').
      const lineItems = lineItemRows.map((li: any) => ({
        quantity:     coalesceNum(li.quantity_corrected,    li.quantity_ocr),
        product_name: coalesceStr(li.name_corrected,        li.name_ocr),
        unit_price:   coalesceNum(li.unit_price_corrected,  li.unit_price_ocr),
        total_price:  coalesceNum(li.total_price_corrected, li.total_price_ocr),
      }))

      const transaction = (tx || subtype) ? {
        amount:          coalesceNum(subtype?.total_amount_corrected,    subtype?.total_amount_ocr),
        net_amount:      coalesceNum(subtype?.net_amount_corrected,      subtype?.net_amount_ocr),
        tax_amount:      coalesceNum(subtype?.tax_amount_corrected,      subtype?.tax_amount_ocr),
        discount_amount: coalesceNum(subtype?.discount_amount_corrected, subtype?.discount_amount_ocr),
        paid_amount:     coalesceNum(subtype?.paid_amount_corrected,     subtype?.paid_amount_ocr),
        currency:        currencyCode,
        currency_symbol: currencyToSymbol(currencyCode),
        merchant:        coalesceStr(store?.name_corrected,    store?.name_ocr),
        document_type:   document_type,
        address:         coalesceStr(store?.address_corrected, store?.address_ocr),
        category:        coalesceStr(subtype?.category_corrected,        subtype?.category_ocr),
        description:     coalesceStr(subtype?.description_corrected,     subtype?.description_ocr),
        transaction_date: transaction_date,
        city:            store?.city_name_ocr ?? null,        // scaffolding column; no _corrected pair
        country:         store?.country_name_ocr ?? null,
        payment_method:  coalesceStr(paymentMethod?.payment_type_corrected, paymentMethod?.payment_type_ocr),
        payment_status:  coalesceStr(subtype?.payment_status_corrected,    subtype?.payment_status_ocr),
        line_items:      lineItems,
      } : { ...emptyTransaction }

      return {
        id: d.id,
        file_path: d.file_path,
        file_url: d.file_url,
        mime_type: d.mime_type,
        file_size: d.file_size,
        created_at: d.created_at,
        ai_summary,
        transaction_date,
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
