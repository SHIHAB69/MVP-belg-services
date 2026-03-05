// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

// ---------------------------------------------------------------------------
// Tool names and definitions
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
// Tool execution (Supabase)
// ---------------------------------------------------------------------------

type ToolResult = { content: string }
type AggregateMode = 'sum_by_currency' | 'group_by_category' | 'group_by_merchant' | 'list'

// Shared helper: fetch all document IDs for a user (with count for diagnostics)
async function getUserDocIds(
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<{ docIds: string[]; documents_found: number }> {
  const { data: docs } = await supabase
    .from('documents')
    .select('id')
    .eq('user_id', userId)
  const docIds = (docs ?? []).map((d: { id: string }) => d.id)
  return { docIds, documents_found: docIds.length }
}

type TxRow = {
  amount: string
  currency?: string | null
  merchant?: string | null
  category?: string | null
  transaction_date?: string | null
  description?: string | null
  city?: string | null
  country?: string | null
}

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
  const { docIds, documents_found } = await getUserDocIds(supabase, userId)
  if (!docIds.length) {
    return {
      content: JSON.stringify({
        result: null,
        documents_found: 0,
        message: 'No documents found for this user.',
      }),
    }
  }

  let query = supabase
    .from('transactions')
    .select('amount, currency, merchant, category, transaction_date, description, city, country')
    .in('document_id', docIds)
    .order('transaction_date', { ascending: false })

  // All filters applied in SQL — no client-side filtering
  if (merchant) query = query.ilike('merchant', `%${merchant}%`)
  if (category) query = query.ilike('category', `%${category}%`)
  if (startDate) query = query.gte('transaction_date', startDate)
  if (endDate) query = query.lte('transaction_date', endDate)

  const { data: rows, error } = await query
  if (error) return { content: JSON.stringify({ error: error.message }) }

  const allRows = (rows ?? []) as TxRow[]

  if (aggregate === 'list') {
    const cap = Math.min(200, Math.max(1, Math.round(limit)))
    const transactions = allRows.slice(0, cap).map((t) => ({
      amount: parseFloat(t.amount),
      currency: t.currency ?? null,
      merchant: t.merchant ?? null,
      category: t.category ?? null,
      transaction_date: t.transaction_date ?? null,
      description: t.description ?? null,
      city: t.city ?? null,
      country: t.country ?? null,
    }))
    return {
      content: JSON.stringify({
        transactions,
        total_matching: allRows.length,
        shown: transactions.length,
        documents_found,
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
    for (const t of allRows) {
      const currency = (t.currency ?? 'USD').toUpperCase()
      const amount = parseFloat(t.amount)
      totals[currency] = (totals[currency] ?? 0) + amount
      transactions.push({
        merchant: t.merchant ?? null,
        amount,
        currency,
        date: t.transaction_date ?? null,
        category: t.category ?? null,
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
    for (const t of allRows) {
      const cat = t.category ?? 'Uncategorized'
      const currency = (t.currency ?? 'USD').toUpperCase()
      if (!grouped[cat]) grouped[cat] = {}
      grouped[cat][currency] = (grouped[cat][currency] ?? 0) + parseFloat(t.amount)
    }
    const by_category = Object.entries(grouped).map(([cat, totals_by_currency]) => ({
      category: cat,
      totals_by_currency,
    }))
    return {
      content: JSON.stringify({ by_category, transaction_count: allRows.length, documents_found }),
    }
  }

  // group_by_merchant
  const grouped: Record<string, Record<string, number>> = {}
  for (const t of allRows) {
    const merch = t.merchant ?? 'Unknown'
    const currency = (t.currency ?? 'USD').toUpperCase()
    if (!grouped[merch]) grouped[merch] = {}
    grouped[merch][currency] = (grouped[merch][currency] ?? 0) + parseFloat(t.amount)
  }
  const by_merchant = Object.entries(grouped).map(([merch, totals_by_currency]) => ({
    merchant: merch,
    totals_by_currency,
  }))
  return {
    content: JSON.stringify({ by_merchant, transaction_count: allRows.length, documents_found }),
  }
}

async function runGetDocumentsSummary(
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<ToolResult> {
  const { data: docs, error } = await supabase
    .from('documents')
    .select('id, ai_summary, created_at, transactions(amount, currency, merchant, category, transaction_date, city, country)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) {
    return { content: JSON.stringify({ error: error.message }) }
  }
  const documents_found = (docs ?? []).length
  const documents = (docs ?? []).map((d: {
    id: string
    ai_summary?: string | null
    created_at: string
    transactions?: unknown
  }) => {
    const raw = d.transactions
    const tx = Array.isArray(raw) && raw.length > 0 ? raw[0] : null
    return {
      document_id: d.id,
      uploaded_at: d.created_at,
      ai_summary: d.ai_summary ?? null,
      merchant: (tx as { merchant?: string | null } | null)?.merchant ?? null,
      amount: (tx as { amount?: string | null } | null)?.amount
        ? parseFloat((tx as { amount: string }).amount)
        : null,
      currency: (tx as { currency?: string | null } | null)?.currency ?? null,
      category: (tx as { category?: string | null } | null)?.category ?? null,
      transaction_date: (tx as { transaction_date?: string | null } | null)?.transaction_date ?? null,
      city: (tx as { city?: string | null } | null)?.city ?? null,
      country: (tx as { country?: string | null } | null)?.country ?? null,
    }
  })
  return { content: JSON.stringify({ documents, documents_found }) }
}

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
// System prompt (pre-computed date ranges injected)
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
- If data is empty, say so plainly. Never fabricate or guess numbers.
- All data is from uploaded receipts (expenses only — there is no income data).
- For questions outside of finance/expenses, answer helpfully and naturally.

## Following user instructions
If the user gives you a behavioural instruction during the conversation — such as "reply in French", "be more formal", "keep answers short", "act like a financial advisor" — follow it immediately and keep following it for the rest of the conversation. User instructions override the default tone and format rules above.`
}

// ---------------------------------------------------------------------------
// Intent detection — only force a tool call when the message is data-related
// ---------------------------------------------------------------------------

function looksLikeDataQuery(text: string): boolean {
  return /spend|spent|cost|paid|total|amount|transaction|receipt|document|upload|merchant|categor|how much|what did|show me|list|last month|this month|this year|history|budget|where did|breakdown|bought|purchase|expensive|cheapest/i.test(
    text
  )
}

// ---------------------------------------------------------------------------
// Chat with tools (OpenAI)
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

  // Only force a tool call on round 0 when the user is actually asking about data
  const lastUserContent =
    [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  const needsDataOnFirstRound = looksLikeDataQuery(
    typeof lastUserContent === 'string' ? lastUserContent : ''
  )

  for (let i = 0; i < 6; i++) {
    const reqBody = JSON.stringify({
      model: 'gpt-4o',
      messages: all,
      tools: OPENAI_TOOLS,
      tool_choice: i === 0 && needsDataOnFirstRound ? 'required' : 'auto',
      max_tokens: 1500,
      temperature: 0.3,
    })
    // Retry once on 429 — wait the duration OpenAI specifies before retrying
    let response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiApiKey}` },
      body: reqBody,
    })
    if (response.status === 429) {
      const retryAfterMs = Math.ceil(parseFloat(response.headers.get('retry-after') ?? '3')) * 1000
      await new Promise((r) => setTimeout(r, retryAfterMs))
      response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiApiKey}` },
        body: reqBody,
      })
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
      all.push({ role: 'tool', content: result.content, tool_call_id: id, name })
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
// Handler
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

    // Only pass user + assistant text messages — tool rounds are excluded to keep
    // token counts low. The assistant's text summary is sufficient context for
    // follow-up questions, and tool_choice:'required' fetches fresh data each turn.
    const openaiMessages: OpenAIMessage[] = rawMessages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: typeof m.content === 'string' ? m.content : '',
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
