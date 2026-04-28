// TODO post-M2: extract coalesceNum/coalesceStr/flattenDocumentForChat/
// CHAT_USER_DATA_SELECT to supabase/functions/_shared/user_data.ts
// (also duplicated in ask/index.ts).

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

// ---------------------------------------------------------------------------
// Tool names and definitions (UNCHANGED from MVP -- byte-identical to GPT)
// ---------------------------------------------------------------------------

const TOOL_NAMES = [
  'search_transactions',
  'get_documents_summary',
] as const

const OPENAI_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'search_transactions',
      description: "Search and aggregate the user's transactions. Use for ALL spending questions. All filters are optional and can be combined freely — merchant+date, category+date, merchant+category+date, etc.",
      parameters: {
        type: 'object' as const,
        properties: {
          merchant: {
            type: 'string' as const,
            description: 'Filter by merchant name (case-insensitive partial match). Omit for all merchants.',
          },
          category: {
            type: 'string' as const,
            description: 'Filter by category (case-insensitive partial match). Omit for all categories.',
          },
          start_date: {
            type: 'string' as const,
            description: 'Start date inclusive (YYYY-MM-DD). Omit for all-time.',
          },
          end_date: {
            type: 'string' as const,
            description: 'End date inclusive (YYYY-MM-DD). Omit for all-time.',
          },
          aggregate: {
            type: 'string' as const,
            enum: ['sum_by_currency', 'group_by_category', 'group_by_merchant', 'list'] as const,
            description:
              'sum_by_currency: total spending (use for "how much did I spend", totals, amounts); ' +
              'group_by_category: breakdown by category (use ONLY when user explicitly asks for category breakdown); ' +
              'group_by_merchant: breakdown per merchant (use ONLY when user explicitly asks per merchant/store); ' +
              'list: individual transactions ordered by date — use for "transaction history", "show my transactions", "what did I buy", "my receipts", "history", "list", "details". Default to this when unsure.',
          },
          limit: {
            type: 'number' as const,
            description: 'For list mode only: max transactions to return (1–200, default 50).',
          },
        },
        required: ['aggregate'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_documents_summary',
      description:
        "Get a summary of all uploaded receipts/documents with their transaction details (merchant, amount, currency, date, city, country, ai_summary). Use for 'what receipts do I have', 'list my documents', 'what did I upload'.",
      parameters: {
        type: 'object' as const,
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
]

// ---------------------------------------------------------------------------
// Tool execution helpers
// ---------------------------------------------------------------------------

type ToolResult = { content: string }
type AggregateMode = 'sum_by_currency' | 'group_by_category' | 'group_by_merchant' | 'list'

// Normalize currency symbols to ISO codes so € and EUR are treated identically
const CURRENCY_SYMBOL_MAP: Record<string, string> = {
  '€': 'EUR', '$': 'USD', '£': 'GBP', '¥': 'JPY', '₹': 'INR',
  '₩': 'KRW', '₺': 'TRY', '₴': 'UAH', '₦': 'NGN', '₫': 'VND',
  '฿': 'THB', 'R$': 'BRL', 'kr': 'SEK', 'zł': 'PLN', 'Kč': 'CZK',
}
function normalizeCurrency(raw: string | null | undefined): string {
  if (!raw) return 'USD'
  const trimmed = raw.trim()
  return (CURRENCY_SYMBOL_MAP[trimmed] ?? trimmed).toUpperCase()
}

// OCR convention: prefer human-edited *_corrected, fall back to extractor *_ocr.
function coalesceNum(corrected: unknown, ocr: unknown): number {
  const v = corrected ?? ocr
  if (v === null || v === undefined) return 0
  const n = Number(v)
  return Number.isNaN(n) ? 0 : n
}
function coalesceStr(corrected: unknown, ocr: unknown): string | null {
  const v = corrected ?? ocr
  return (typeof v === 'string' && v.length > 0) ? v : null
}

// Flat per-transaction record assembled from the JOINed embed.
type FlatTxChat = {
  amount: number
  currency: string | null   // RAW (not normalized) -- normalize at the call site that needs it
  merchant: string | null
  category: string | null
  description: string | null
  transaction_date: string | null
  city: string | null
  country: string | null
}

function flattenDocumentForChat(d: any): FlatTxChat[] {
  const txArr: any[] = Array.isArray(d.transactions) ? d.transactions : (d.transactions ? [d.transactions] : [])
  const receipt = Array.isArray(d.receipts) ? (d.receipts[0] ?? null) : (d.receipts ?? null)
  const invoice = Array.isArray(d.invoices) ? (d.invoices[0] ?? null) : (d.invoices ?? null)
  const subtype = receipt ?? invoice
  const store = receipt?.stores ?? null               // invoices have no store yet (Decision 14)
  return txArr.map((tx: any) => ({
    amount:           coalesceNum(tx.amount_corrected,           tx.amount_ocr),
    currency:         coalesceStr(tx.currency_corrected,         tx.currency_ocr),       // raw, not normalized
    merchant:         coalesceStr(store?.name_corrected,         store?.name_ocr),
    category:         coalesceStr(subtype?.category_corrected,   subtype?.category_ocr),
    description:      coalesceStr(subtype?.description_corrected, subtype?.description_ocr),
    transaction_date: coalesceStr(tx.transaction_date_corrected, tx.transaction_date_ocr),
    city:             store?.city_name_ocr ?? null,            // scaffolding column; no _corrected pair
    country:          store?.country_name_ocr ?? null,
  }))
}

// One-round-trip embed -- documents + their transactions + subtype + store.
// ai_summary_* are fetched but only used by get_documents_summary's per-doc
// aggregation block (currently NOT exposed in the output -- preserves MVP bug
// behavior; see note in runGetDocumentsSummary below).
const CHAT_USER_DATA_SELECT = `
  id, ai_summary_ocr, ai_summary_corrected, created_at,
  transactions (
    amount_ocr, amount_corrected,
    currency_ocr, currency_corrected,
    transaction_date_ocr, transaction_date_corrected
  ),
  receipts (
    category_ocr, category_corrected,
    description_ocr, description_corrected,
    stores (
      name_ocr, name_corrected,
      city_name_ocr, country_name_ocr
    )
  ),
  invoices (
    category_ocr, category_corrected,
    description_ocr, description_corrected
  )
`

async function fetchUserDocsForChat(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  options: { orderRecentDesc?: boolean; limit?: number } = {}
) {
  let q = supabase.from('documents').select(CHAT_USER_DATA_SELECT).eq('user_id', userId)
  if (options.orderRecentDesc) q = q.order('created_at', { ascending: false })
  if (options.limit) q = q.limit(options.limit)
  const { data, error } = await q
  if (error) throw error
  return data ?? []
}

// ---------------------------------------------------------------------------
// Tool: search_transactions
// ---------------------------------------------------------------------------
async function runSearchTransactions(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  merchant: string | null,
  category: string | null,
  startDate: string | null,
  endDate: string | null,
  aggregate: AggregateMode,
  limit: number
): Promise<ToolResult> {
  // One round trip: documents + their transactions + receipts/invoices + stores.
  const docs = await fetchUserDocsForChat(supabase, userId)
  const documents_found = docs.length
  if (documents_found === 0) {
    return {
      content: JSON.stringify({
        result: null,
        documents_found: 0,
        message: 'No documents found for this user.',
      }),
    }
  }

  // Flatten documents into MVP-shaped transaction records.
  const allFlat = docs.flatMap(flattenDocumentForChat)

  // Filters moved from SQL to JS so they observe COALESCE(_corrected, _ocr)
  // semantics. Same observable behaviour as the old .ilike / .gte / .lte.
  let filtered = allFlat
  if (merchant) {
    const needle = merchant.toLowerCase()
    filtered = filtered.filter(t => (t.merchant ?? '').toLowerCase().includes(needle))
  }
  if (category) {
    const needle = category.toLowerCase()
    filtered = filtered.filter(t => (t.category ?? '').toLowerCase().includes(needle))
  }
  if (startDate) {
    filtered = filtered.filter(t => t.transaction_date !== null && t.transaction_date >= startDate)
  }
  if (endDate) {
    filtered = filtered.filter(t => t.transaction_date !== null && t.transaction_date <= endDate)
  }

  // Sort by transaction_date desc (matches old .order('transaction_date', desc)).
  // Nulls sort last via empty-string fallback.
  filtered.sort((a, b) => (b.transaction_date ?? '').localeCompare(a.transaction_date ?? ''))

  if (aggregate === 'list') {
    const cap = Math.min(200, Math.max(1, Math.round(limit)))
    // PRESERVED QUIRK: per-row 'currency' here is the RAW value (not normalized).
    // totals_by_currency below uses NORMALIZED currency. Matches MVP byte-for-byte.
    const transactions = filtered.slice(0, cap).map(t => ({
      amount: t.amount,
      currency: t.currency,
      merchant: t.merchant,
      category: t.category,
      transaction_date: t.transaction_date,
      description: t.description,
      city: t.city,
      country: t.country,
    }))
    // Grand totals across ALL matching rows, not just the shown slice.
    const totals_by_currency: Record<string, number> = {}
    for (const t of filtered) {
      const currency = normalizeCurrency(t.currency)
      totals_by_currency[currency] = Math.round(((totals_by_currency[currency] ?? 0) + t.amount) * 100) / 100
    }
    return {
      content: JSON.stringify({
        transactions,
        totals_by_currency,
        total_matching: filtered.length,
        shown: transactions.length,
        documents_found,
        ...(filtered.length > cap
          ? { grand_total_note: `Totals cover all ${filtered.length} matching transactions, not just the ${cap} shown.` }
          : {}),
      }),
    }
  }

  if (aggregate === 'sum_by_currency') {
    const totals: Record<string, number> = {}
    const transactions: Array<{
      merchant: string | null
      amount: number
      currency: string
      date: string | null
      category: string | null
    }> = []
    for (const t of filtered) {
      const currency = normalizeCurrency(t.currency)
      totals[currency] = Math.round(((totals[currency] ?? 0) + t.amount) * 100) / 100
      transactions.push({
        merchant: t.merchant,
        amount: t.amount,
        currency,                 // NORMALIZED here (preserved MVP shape)
        date: t.transaction_date,
        category: t.category,
      })
    }
    return {
      content: JSON.stringify({
        totals_by_currency: totals,
        transaction_count: transactions.length,
        documents_found,
        transactions,
      }),
    }
  }

  if (aggregate === 'group_by_category') {
    const grouped: Record<string, Record<string, number>> = {}
    for (const t of filtered) {
      const cat = t.category ?? 'Uncategorized'
      const currency = normalizeCurrency(t.currency)
      if (!grouped[cat]) grouped[cat] = {}
      grouped[cat][currency] = Math.round(((grouped[cat][currency] ?? 0) + t.amount) * 100) / 100
    }
    const by_category = Object.entries(grouped).map(([cat, totals_by_currency]) => ({
      category: cat,
      totals_by_currency,
    }))
    return {
      content: JSON.stringify({ by_category, transaction_count: filtered.length, documents_found }),
    }
  }

  // aggregate === 'group_by_merchant'
  const grouped: Record<string, Record<string, number>> = {}
  for (const t of filtered) {
    const merch = t.merchant ?? 'Unknown'
    const currency = normalizeCurrency(t.currency)
    if (!grouped[merch]) grouped[merch] = {}
    grouped[merch][currency] = Math.round(((grouped[merch][currency] ?? 0) + t.amount) * 100) / 100
  }
  const by_merchant = Object.entries(grouped).map(([merch, totals_by_currency]) => ({
    merchant: merch,
    totals_by_currency,
  }))
  return {
    content: JSON.stringify({ by_merchant, transaction_count: filtered.length, documents_found }),
  }
}

// ---------------------------------------------------------------------------
// Tool: get_documents_summary
// ---------------------------------------------------------------------------
// PRESERVED MVP BUG: ai_summary is SELECTed (CHAT_USER_DATA_SELECT) but NOT
// exposed in the per-document output object. The tool description tells GPT
// it returns ai_summary, but the implementation never includes it. Preserved
// verbatim per Decision (no behaviour change in M2). Add to per-doc output
// post-M2 if/when the tool description is cleaned up.
async function runGetDocumentsSummary(
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<ToolResult> {
  const docs = await fetchUserDocsForChat(supabase, userId, { orderRecentDesc: true, limit: 50 })
  const documents_found = docs.length

  const documents = docs.map((d: any) => {
    const txs = flattenDocumentForChat(d)
    const firstTx = txs.length > 0 ? txs[0] : null

    // Aggregate per-document totals across all transactions (matches MVP).
    const total_amount_by_currency: Record<string, number> = {}
    for (const t of txs) {
      const currency = normalizeCurrency(t.currency)
      total_amount_by_currency[currency] = Math.round(
        ((total_amount_by_currency[currency] ?? 0) + t.amount) * 100
      ) / 100
    }

    // Unique non-null merchants across all transactions on this document.
    const merchants = [...new Set(txs.map(t => t.merchant).filter((m): m is string => m !== null))]

    return {
      uploaded_at: d.created_at,
      transaction_count: txs.length,
      total_amount_by_currency,
      merchants,
      merchant: firstTx?.merchant ?? null,
      amount: firstTx?.amount ?? null,
      currency: firstTx?.currency ?? null,           // RAW, matches MVP (which returned t.currency directly)
      category: firstTx?.category ?? null,
      transaction_date: firstTx?.transaction_date ?? null,
      city: firstTx?.city ?? null,
      country: firstTx?.country ?? null,
    }
  })

  return {
    content: JSON.stringify({ documents, documents_found }),
  }
}

// ---------------------------------------------------------------------------
// Tool dispatch (UNCHANGED from MVP)
// ---------------------------------------------------------------------------
async function executeTool(
  name: string,
  args: Record<string, unknown>,
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<ToolResult> {
  switch (name) {
    case 'search_transactions': {
      const merchant =
        typeof args.merchant === 'string' && args.merchant ? args.merchant : null
      const category =
        typeof args.category === 'string' && args.category ? args.category : null
      const startDate =
        typeof args.start_date === 'string' && args.start_date ? args.start_date : null
      const endDate =
        typeof args.end_date === 'string' && args.end_date ? args.end_date : null
      const validAggregates: AggregateMode[] = [
        'sum_by_currency',
        'group_by_category',
        'group_by_merchant',
        'list',
      ]
      const aggregate: AggregateMode = validAggregates.includes(args.aggregate as AggregateMode)
        ? (args.aggregate as AggregateMode)
        : 'sum_by_currency'
      const limit = typeof args.limit === 'number' ? args.limit : 50
      return runSearchTransactions(
        supabase,
        userId,
        merchant,
        category,
        startDate,
        endDate,
        aggregate,
        limit
      )
    }
    case 'get_documents_summary':
      return runGetDocumentsSummary(supabase, userId)
    default:
      return { content: JSON.stringify({ error: `Unknown tool: ${name}` }) }
  }
}

// ---------------------------------------------------------------------------
// System prompt (UNCHANGED from MVP -- pre-computed date ranges injected)
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  const now = new Date()
  const currentYear = now.getFullYear()
  const m = now.getMonth()
  const currentDate = now.toISOString().split('T')[0]
  const firstOfMonth = `${currentDate.slice(0, 7)}-01`
  const lastOfMonth = new Date(currentYear, m + 1, 0).toISOString().split('T')[0]
  const firstOfYear = `${currentYear}-01-01`
  const lastOfYear = `${currentYear}-12-31`
  const lastMonthDate = new Date(currentYear, m, 0)
  const lastMonthEnd = lastMonthDate.toISOString().split('T')[0]
  const lastMonthStart = `${lastMonthEnd.slice(0, 7)}-01`

  return `You are a smart, friendly personal finance assistant built into an expense-tracking app. Today is ${currentDate}.

You have access to the user's uploaded receipt data through tools. Think of yourself as a knowledgeable friend who genuinely understands their finances — you can read between the lines of what they're asking, handle follow-ups naturally, and give clear, accurate answers.

## Your tools

### search_transactions(merchant?, category?, start_date?, end_date?, aggregate, limit?)
The primary tool for ALL transaction questions. All filters are optional and stack freely.

**aggregate values — pick the one that matches the question:**
- "sum_by_currency" → total spending (use for "how much did I spend", "what's my total", "how much at X")
- "group_by_category" → use ONLY when the user explicitly asks for a category breakdown ("by category", "per category", "what categories")
- "group_by_merchant" → use ONLY when the user explicitly asks per merchant/store ("by merchant", "top stores", "where did I shop")
- "list" → individual transactions ordered by date. Use this for: "transaction history", "show my transactions", "my history", "what did I buy", "details", "list my transactions", "last transaction" (limit=1), "all transactions" (limit=50). When in doubt, default to "list".

**Filter combinations — all work:**
- merchant="Carrefour", start_date, end_date → spending at Carrefour last month
- category="groceries", start_date, end_date → grocery spending in a period
- merchant="Uber", aggregate="sum_by_currency" → all-time Uber spending
- no filters, aggregate="group_by_category" → full category breakdown all-time
- no filters, aggregate="sum_by_currency" → all-time grand total

### get_documents_summary()
List all uploaded receipts with details. Use for "what receipts do I have", "list my documents".

## Understanding time periods
Always use these exact pre-computed dates — never calculate your own:
- "this month" → ${firstOfMonth} to ${lastOfMonth}
- "this year" → ${firstOfYear} to ${lastOfYear}
- "last month" → ${lastMonthStart} to ${lastMonthEnd}
- "year YYYY" → YYYY-01-01 to YYYY-12-31
- No time period mentioned → omit date filters entirely (returns all-time data)

## Reading tool results
- Every result includes "documents_found". If the user says they have more receipts than this number, warn them: "I can only see X receipt(s) in your current session — others may be under a different account."
- For list results, "total_matching" shows how many transactions matched — "shown" is how many are returned. If total_matching > shown, mention that there are more.
- If a transaction's category seems wrong, mention it.
- When reporting totals, list the individual transactions so the user can verify.

## Tone and format
- Be natural and direct. Answer the question, then stop. No filler endings.
- Plain text only — no markdown. No bold (**), no italics (*), no headers (#). Use plain dashes for lists.
- Never mix currencies in a single total — always list them separately (e.g. EUR 173.87 · USD 25.97).
- In this app, currency symbols and currency codes are the same thing. € = EUR, $ = USD, £ = GBP, ₹ = INR, and so on. Always treat them as identical — never say they are different.
- If data is empty, say so plainly. Never fabricate or guess numbers.
- All data is from uploaded receipts (expenses only — there is no income data).
- For questions outside of finance/expenses, answer helpfully and naturally.

## Critical rules — never break these
1. Before answering ANY question involving amounts, spending, merchants, categories, dates, or receipts — ALWAYS call a tool first, even if you think you already know the answer. Never state a number, total, or transaction detail from memory.
2. For follow-up questions ("what about last month?", "and for groceries?", "how about Uber?") — call search_transactions again with the updated filters. Do not reuse prior tool results.
3. If the user asks about both a total AND wants to see the list — call search_transactions with aggregate="list". The result now includes "totals_by_currency" covering all matching rows, so you can report both the list and the total accurately.
4. If a tool returns zero transactions, say so plainly. Do not guess or invent numbers.
5. NEVER show internal IDs (document IDs, UUIDs, database keys) to the user — they are meaningless to them. Identify receipts by merchant, date, amount, and city/country instead.
6. For duplicate detection questions ("show duplicates", "what's uploaded twice", "doubled entries", etc.) — call search_transactions with aggregate="list" and limit=50. This returns individual transactions in a flat list. Then compare every transaction against every other using merchant + amount + currency. Rules:
   - Two transactions are duplicates if merchant + amount + currency all match.
   - Minor category/city/country differences are fine — still flag as duplicate.
   - NEVER use transaction_date to exclude — same receipt uploaded on different days still counts.
   - Group all matching transactions together and report: merchant, amount, currency, category, date, city/country, and how many times it appears.
   - Example: "Imran Travels Pvt Ltd · USD 907.00 · Travel · Dhaka, Bangladesh — appears 3 times."
7. For questions about documents/receipts list ("what did I upload", "list my receipts") — call get_documents_summary.
8. For follow-up questions like "show their details", "show their amounts" after a duplicate query — call search_transactions with aggregate="list" and limit=50 again.

## Following user instructions
If the user gives you a behavioural instruction during the conversation — such as "reply in French", "be more formal", "keep answers short", "act like a financial advisor" — follow it immediately and keep following it for the rest of the conversation. User instructions override the default tone and format rules above.`
}

// ---------------------------------------------------------------------------
// Chat with tools (OpenAI) -- UNCHANGED from MVP
// ---------------------------------------------------------------------------

type OpenAIMessage =
  | {
      role: 'system' | 'user' | 'assistant'
      content: string | null
      tool_calls?: unknown[]
      tool_call_id?: string
      name?: string
    }
  | { role: 'tool'; content: string; tool_call_id: string; name?: string }

async function chatWithTools(
  openaiApiKey: string,
  systemPrompt: string,
  messages: OpenAIMessage[],
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<OpenAIMessage[]> {
  const all: OpenAIMessage[] = [{ role: 'system', content: systemPrompt }, ...messages]

  for (let i = 0; i < 6; i++) {
    const buildReqBody = (model: string) => JSON.stringify({
      model,
      messages: all,
      tools: OPENAI_TOOLS,
      tool_choice: 'auto',
      max_tokens: 2500,
      temperature: 0.3,
    })
    const callOpenAI = (model: string) =>
      fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiApiKey}` },
        body: buildReqBody(model),
      })

    // Try gpt-4o first; on 429 fall back to gpt-4o-mini immediately
    let response = await callOpenAI('gpt-4o')
    if (response.status === 429) {
      response = await callOpenAI('gpt-4o-mini')
    }
    // If mini also rate-limits, wait and retry mini once more
    if (response.status === 429) {
      const retryAfterMs = Math.ceil(parseFloat(response.headers.get('retry-after') ?? '3')) * 1000
      await new Promise((r) => setTimeout(r, retryAfterMs))
      response = await callOpenAI('gpt-4o-mini')
    }
    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`OpenAI API error: ${response.status} ${errText}`)
    }
    const data = (await response.json()) as {
      choices?: Array<{
        message?: {
          role?: string
          content?: string | null
          tool_calls?: Array<{
            id?: string
            function?: { name?: string; arguments?: string }
          }>
        }
      }>
    }
    const choice = data.choices?.[0]?.message
    if (!choice) throw new Error('Empty OpenAI response')

    const assistantMsg: OpenAIMessage = {
      role: 'assistant',
      content: choice.content ?? null,
      tool_calls: choice.tool_calls,
    }
    all.push(assistantMsg)

    if (!choice.tool_calls?.length) return all

    for (const tc of choice.tool_calls) {
      const id = tc.id ?? ''
      const name = tc.function?.name ?? ''
      const rawArgs = tc.function?.arguments ?? '{}'
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(rawArgs) as Record<string, unknown>
      } catch {
        args = {}
      }
      if (!TOOL_NAMES.includes(name as (typeof TOOL_NAMES)[number])) {
        all.push({
          role: 'tool',
          content: JSON.stringify({ error: `Unknown tool: ${name}` }),
          tool_call_id: id,
          name,
        })
        continue
      }
      const result = await executeTool(name, args, supabase, userId)
      // Cap tool result at ~12,000 chars (~3,000 tokens) to stay within TPM limits.
      // If truncated, append a note so GPT knows the list was cut short.
      const MAX_TOOL_CHARS = 12000
      const toolContent = result.content.length > MAX_TOOL_CHARS
        ? result.content.slice(0, MAX_TOOL_CHARS) + '"},"_note":"Result truncated to fit token limits. Ask the user to narrow the query if more data is needed."}'
        : result.content
      all.push({ role: 'tool', content: toolContent, tool_call_id: id, name })
    }
  }
  return all
}

// ---------------------------------------------------------------------------
// TTS: convert answer text to audio base64 for voice_enabled responses
// ---------------------------------------------------------------------------

async function textToSpeechBase64(apiKey: string, text: string): Promise<string | null> {
  if (!text || text.length > 4096) return null
  try {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: 'tts-1', input: text, voice: 'alloy' }),
    })
    if (!response.ok) return null
    const arrayBuffer = await response.arrayBuffer()
    const bytes = new Uint8Array(arrayBuffer)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    return btoa(binary)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Handler (UNCHANGED from MVP)
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 405,
      })
    }

    const body = (await req.json().catch(() => ({}))) as {
      user_id?: string
      messages?: Array<{ role: string; content: unknown }>
      voice_enabled?: boolean
      instructions?: string
    }

    const user_id = typeof body?.user_id === 'string' ? body.user_id.trim() : ''
    const rawMessages = Array.isArray(body?.messages) ? body.messages : []

    if (!user_id) {
      return new Response(JSON.stringify({ error: 'Missing or invalid user_id' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 400,
      })
    }
    if (rawMessages.length === 0) {
      return new Response(JSON.stringify({ error: 'Missing or empty messages' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 400,
      })
    }

    const openaiApiKey = Deno.env.get('OPENAI_API_KEY')
    if (!openaiApiKey) {
      return new Response(JSON.stringify({ error: 'Service configuration error' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 500,
      })
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(JSON.stringify({ error: 'Service configuration error' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 500,
      })
    }
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const customInstructions = typeof body.instructions === 'string' ? body.instructions.trim() : ''
    const systemPrompt = customInstructions
      ? `${buildSystemPrompt()}\n\n## Custom instructions\n${customInstructions}`
      : buildSystemPrompt()

    // Only pass user + assistant text messages -- tool rounds are excluded to keep
    // token counts low. The assistant's text summary is sufficient context for
    // follow-up questions, and the system prompt instructs GPT to always re-fetch.
    // Cap at last 10 messages to prevent unbounded history growth (large responses
    // like transaction lists accumulate quickly and blow past token limits).
    const MAX_HISTORY = 10
    const openaiMessages: OpenAIMessage[] = rawMessages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: typeof m.content === 'string' ? m.content : '',
      }))
      .slice(-MAX_HISTORY)
      .map((m) => ({
        ...m,
        // Truncate individual messages to 2000 chars to prevent a single huge
        // transaction-list response from dominating the context window.
        content: typeof m.content === 'string' && m.content.length > 2000
          ? m.content.slice(0, 2000) + '… [truncated]'
          : m.content,
      }))

    const resultMessages = await chatWithTools(
      openaiApiKey,
      systemPrompt,
      openaiMessages,
      supabase,
      user_id
    )

    const assistantOnly = resultMessages.filter((m) => m.role === 'assistant')
    const lastAssistant = assistantOnly[assistantOnly.length - 1]
    const raw_text = (lastAssistant?.content ?? '').trim()
    // Strip markdown formatting in case the model ignores the plain-text instruction
    const answer_text = raw_text.replace(/\*\*/g, '').replace(/^#{1,6}\s/gm, '').trim() || null

    const voice_enabled = body?.voice_enabled === true
    let audio_base64: string | null = null
    if (voice_enabled && answer_text) {
      audio_base64 = await textToSpeechBase64(openaiApiKey, answer_text)
    }

    // Return only user + assistant messages that have actual text content.
    // - Tool messages are excluded (large JSON blobs that bloat tokens on every turn).
    // - Assistant messages with no text (tool-call-only rounds) are excluded so they
    //   don't appear as empty strings in the next turn's history.
    const safeMessages: OpenAIMessage[] = resultMessages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .filter((m) => typeof m.content === 'string' && m.content.trim().length > 0)
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: (m.content as string).replace(/\*\*/g, '').replace(/^#{1,6}\s/gm, '').trim(),
      }))

    const payload: {
      messages: OpenAIMessage[]
      answer_text?: string | null
      audio_base64?: string | null
    } = { messages: safeMessages }
    if (answer_text !== undefined) payload.answer_text = answer_text
    if (voice_enabled) payload.audio_base64 = audio_base64 ?? null

    return new Response(JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (error) {
    console.error('chat error:', error)
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Chat failed',
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})
