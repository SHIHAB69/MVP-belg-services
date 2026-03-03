// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

// ---------------------------------------------------------------------------
// Tool names and definitions
// ---------------------------------------------------------------------------

const TOOL_NAMES = [
  'get_total_spending',
  'get_spending_by_merchant',
  'get_recent_transactions',
  'get_spending_by_category',
  'get_documents_summary',
] as const

const OPENAI_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'get_total_spending',
      description: "Get the user's total spending, returned as totals grouped by currency with a per-transaction breakdown. Omit both dates for all-time total. Pass start_date+end_date for a specific period (ISO 8601 YYYY-MM-DD).",
      parameters: {
        type: 'object' as const,
        properties: {
          start_date: { type: 'string' as const, description: 'Start date inclusive (YYYY-MM-DD). Omit for all-time.' },
          end_date: { type: 'string' as const, description: 'End date inclusive (YYYY-MM-DD). Omit for all-time.' },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_spending_by_merchant',
      description: "Get total spending for a specific merchant (case-insensitive match), grouped by currency.",
      parameters: {
        type: 'object' as const,
        properties: {
          merchant: { type: 'string' as const, description: 'Merchant name to filter by' },
        },
        required: ['merchant'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_recent_transactions',
      description: "Get the user's transactions ordered by transaction_date descending (most recent transaction date first). Includes city and country. Use limit=1 for 'last/most recent transaction'. Use limit=50 for 'all transactions', 'history', or 'list my transactions'.",
      parameters: {
        type: 'object' as const,
        properties: {
          limit: { type: 'number' as const, description: 'Use 1 for last/most recent only; use 50 for full history or list of transactions (1-50)' },
        },
        required: ['limit'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_spending_by_category',
      description: "Get the user's spending grouped by category, with totals per currency. Supports optional date range and category filter. Use for 'spending by category', 'groceries', 'restaurants', or any category-specific spending questions.",
      parameters: {
        type: 'object' as const,
        properties: {
          start_date: { type: 'string' as const, description: 'Start date inclusive (YYYY-MM-DD), optional' },
          end_date: { type: 'string' as const, description: 'End date inclusive (YYYY-MM-DD), optional' },
          category: { type: 'string' as const, description: 'Category name to filter by (optional, case-insensitive)' },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_documents_summary',
      description: "Get a summary of all uploaded receipts/documents with their transaction details (merchant, amount, currency, date, city, country, ai_summary). Use for 'what receipts do I have', 'list my documents', 'what did I upload'.",
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

async function runGetTotalSpending(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  startDate: string | null,
  endDate: string | null
): Promise<ToolResult> {
  const { docIds, documents_found } = await getUserDocIds(supabase, userId)
  if (!docIds.length) {
    return { content: JSON.stringify({ totals_by_currency: {}, documents_found: 0, message: 'No documents found for this user.' }) }
  }
  let query = supabase
    .from('transactions')
    .select('amount, currency, merchant, transaction_date, category')
    .in('document_id', docIds)
    .order('transaction_date', { ascending: false })
  if (startDate) query = query.gte('transaction_date', startDate)
  if (endDate) query = query.lte('transaction_date', endDate)
  const { data: rows, error } = await query
  if (error) {
    return { content: JSON.stringify({ error: error.message }) }
  }
  const totals_by_currency: Record<string, number> = {}
  const transactions: Array<{ merchant: string | null; amount: number; currency: string; date: string | null; category: string | null }> = []
  for (const t of rows ?? []) {
    const currency = (t.currency ?? 'USD').toUpperCase()
    const amount = parseFloat(t.amount)
    totals_by_currency[currency] = (totals_by_currency[currency] ?? 0) + amount
    transactions.push({
      merchant: t.merchant ?? null,
      amount,
      currency,
      date: t.transaction_date ?? null,
      category: t.category ?? null,
    })
  }
  const label = startDate && endDate ? `${startDate} to ${endDate}` : 'all-time'
  return { content: JSON.stringify({ totals_by_currency, transaction_count: transactions.length, documents_found, transactions, period: label }) }
}

async function runGetSpendingByMerchant(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  merchant: string
): Promise<ToolResult> {
  const { docIds, documents_found } = await getUserDocIds(supabase, userId)
  if (!docIds.length) {
    return { content: JSON.stringify({ totals_by_currency: {}, merchant, documents_found: 0, message: 'No documents found for this user.' }) }
  }
  const { data: rows, error } = await supabase
    .from('transactions')
    .select('amount, currency, merchant')
    .in('document_id', docIds)
  if (error) {
    return { content: JSON.stringify({ error: error.message }) }
  }
  const needle = merchant.toLowerCase()
  const totals_by_currency: Record<string, number> = {}
  for (const t of (rows ?? []).filter((t: { merchant?: string | null }) => (t.merchant ?? '').toLowerCase().includes(needle))) {
    const currency = ((t as { currency?: string | null }).currency ?? 'USD').toUpperCase()
    totals_by_currency[currency] = (totals_by_currency[currency] ?? 0) + parseFloat((t as { amount: string }).amount)
  }
  return { content: JSON.stringify({ totals_by_currency, merchant, documents_found }) }
}

/** Recent = ordered by transaction_date descending (most recent transaction date first). */
async function runGetRecentTransactions(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  limit: number
): Promise<ToolResult> {
  const capped = Math.min(50, Math.max(1, Math.round(limit)))
  const { docIds, documents_found } = await getUserDocIds(supabase, userId)
  if (!docIds.length) {
    return { content: JSON.stringify({ transactions: [], documents_found: 0, message: 'No documents found for this user.' }) }
  }
  const { data: txRows, error } = await supabase
    .from('transactions')
    .select('document_id, amount, currency, merchant, category, transaction_date, description, city, country')
    .in('document_id', docIds)
    .order('transaction_date', { ascending: false })
    .limit(capped)
  if (error) {
    return { content: JSON.stringify({ error: error.message }) }
  }
  const transactions = (txRows ?? []).map((t: {
    amount: string; currency?: string | null; merchant?: string | null; category?: string | null;
    transaction_date?: string | null; description?: string | null; city?: string | null; country?: string | null
  }) => ({
    amount: t.amount,
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
      documents_found,
      total_transactions_in_account: docIds.length,
    }),
  }
}

async function runGetSpendingByCategory(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  startDate: string | null,
  endDate: string | null,
  filterCategory: string | null
): Promise<ToolResult> {
  const { docIds, documents_found } = await getUserDocIds(supabase, userId)
  if (!docIds.length) {
    return { content: JSON.stringify({ by_category: [], documents_found: 0, message: 'No documents found for this user.' }) }
  }
  let query = supabase
    .from('transactions')
    .select('amount, currency, category')
    .in('document_id', docIds)
  if (startDate) query = query.gte('transaction_date', startDate)
  if (endDate) query = query.lte('transaction_date', endDate)
  const { data: rows, error } = await query
  if (error) {
    return { content: JSON.stringify({ error: error.message }) }
  }
  const needle = filterCategory ? filterCategory.toLowerCase() : null
  const grouped: Record<string, Record<string, number>> = {}
  for (const t of (rows ?? []) as Array<{ amount: string; currency?: string | null; category?: string | null }>) {
    const cat = t.category ?? 'Uncategorized'
    if (needle && !cat.toLowerCase().includes(needle)) continue
    const currency = (t.currency ?? 'USD').toUpperCase()
    if (!grouped[cat]) grouped[cat] = {}
    grouped[cat][currency] = (grouped[cat][currency] ?? 0) + parseFloat(t.amount)
  }
  const by_category = Object.entries(grouped).map(([category, totals_by_currency]) => ({
    category,
    totals_by_currency,
  }))
  return {
    content: JSON.stringify({
      by_category,
      documents_found,
      start_date: startDate,
      end_date: endDate,
      filter_category: filterCategory,
    }),
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
      amount: (tx as { amount?: string | null } | null)?.amount ?? null,
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
    case 'get_total_spending': {
      const start = typeof args.start_date === 'string' && args.start_date ? args.start_date : null
      const end = typeof args.end_date === 'string' && args.end_date ? args.end_date : null
      return runGetTotalSpending(supabase, userId, start, end)
    }
    case 'get_spending_by_merchant': {
      const merchant = typeof args.merchant === 'string' ? args.merchant : ''
      return runGetSpendingByMerchant(supabase, userId, merchant)
    }
    case 'get_recent_transactions': {
      const limit = typeof args.limit === 'number' ? args.limit : 10
      return runGetRecentTransactions(supabase, userId, limit)
    }
    case 'get_spending_by_category': {
      const startDate = typeof args.start_date === 'string' ? args.start_date : null
      const endDate = typeof args.end_date === 'string' ? args.end_date : null
      const category = typeof args.category === 'string' ? args.category : null
      return runGetSpendingByCategory(supabase, userId, startDate, endDate, category)
    }
    case 'get_documents_summary': {
      return runGetDocumentsSummary(supabase, userId)
    }
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
- get_total_spending(start_date?, end_date?) — sum of all spending; omit dates for all-time total
- get_spending_by_category(start_date?, end_date?, category?) — breakdown by category
- get_spending_by_merchant(merchant) — spending at a specific store or brand
- get_recent_transactions(limit) — latest receipts ordered by date (1 = most recent, 50 = full history)
- get_documents_summary() — list all uploaded receipts with details

## Understanding time periods
Always use these exact pre-computed dates — never calculate your own:
- "this month" → ${firstOfMonth} to ${lastOfMonth}
- "this year" → ${firstOfYear} to ${lastOfYear}
- "last month" → ${lastMonthStart} to ${lastMonthEnd}
- "year YYYY" → YYYY-01-01 to YYYY-12-31
- No time period mentioned (e.g. "how much in total?", "what's my spending?") → call the tool with NO date filter for all-time data

## Using your tools well
You always receive a fresh tool result on every turn — use it, not anything from conversation history. The user's data can change at any time (they may have added or deleted receipts since the last message).

Pick the tool that best matches the user's intent:
- Spending totals → get_total_spending (with dates only if a period was specified)
- Category breakdown → get_spending_by_category (add dates/category only if mentioned)
- Specific store → get_spending_by_merchant
- Viewing transactions → get_recent_transactions with an appropriate limit
- Follow-up questions like "and in total?", "what about last month?", "break it down" → understand the context from the conversation and call the right tool

When you get tool results, reason about them before answering:
- Every tool result includes a "documents_found" count. If the user mentions they have more receipts than this number, warn them: "I can only see X receipt(s) linked to your current account session. If you uploaded others in a previous session, they may be under a different account ID — this is a known limitation of anonymous sessions."
- If a transaction's category seems wrong (e.g., Transportation for a grocery receipt), mention it.
- If a single amount seems unusually large, flag it so the user can check whether the receipt was scanned correctly.

When reporting totals, list the individual transactions that were summed so the user can verify the numbers.

## Tone and format
- Be natural and direct. Answer the question, then stop. No filler endings like "Feel free to ask!" or "Let me know if you need anything else!"
- Never mix currencies in a single total — always list them separately (e.g. EUR 173.87 · USD 25.97)
- If data is empty, say so plainly. Never fabricate or guess numbers.
- All data is from uploaded receipts (expenses only — there is no income data).
- For questions outside of finance/expenses, answer helpfully and naturally.`
}

// ---------------------------------------------------------------------------
// Chat with tools (OpenAI)
// ---------------------------------------------------------------------------

type OpenAIMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string | null; tool_calls?: unknown[]; tool_call_id?: string; name?: string }
  | { role: 'tool'; content: string; tool_call_id: string; name?: string }

async function chatWithTools(
  openaiApiKey: string,
  systemPrompt: string,
  messages: OpenAIMessage[],
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<OpenAIMessage[]> {
  const all: OpenAIMessage[] = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ]
  for (let i = 0; i < 10; i++) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: all,
        tools: OPENAI_TOOLS.length ? OPENAI_TOOLS : undefined,
        // First round: 'required' forces a fresh tool call even when the model
        // sees a previous identical answer in conversation history. This prevents
        // the AI from reusing stale data (e.g. after the user deletes receipts).
        // Subsequent rounds: 'auto' lets the model decide whether to call more tools.
        tool_choice: OPENAI_TOOLS.length ? (i === 0 ? 'required' : 'auto') : undefined,
        max_tokens: 1500,
        temperature: 0.5,
      }),
    })
    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`OpenAI API error: ${response.status} ${errText}`)
    }
    const data = (await response.json()) as {
      choices?: Array<{
        message?: {
          role?: string
          content?: string | null
          tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
        }
      }>
    }
    const choice = data.choices?.[0]?.message
    if (!choice) {
      throw new Error('Empty OpenAI response')
    }
    const assistantMsg: OpenAIMessage = {
      role: 'assistant',
      content: choice.content ?? null,
      tool_calls: choice.tool_calls,
    }
    all.push(assistantMsg)
    if (!choice.tool_calls?.length) {
      return all
    }
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
      all.push({
        role: 'tool',
        content: result.content,
        tool_call_id: id,
        name,
      })
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
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: text,
        voice: 'alloy',
      }),
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
      return new Response(
        JSON.stringify({ error: 'Method not allowed' }),
        { headers: { 'Content-Type': 'application/json' }, status: 405 }
      )
    }
    const body = await req.json().catch(() => ({})) as {
      user_id?: string
      messages?: Array<{ role: string; content: unknown }>
      voice_enabled?: boolean
    }
    const user_id = typeof body?.user_id === 'string' ? body.user_id.trim() : ''
    const messages = Array.isArray(body?.messages) ? body.messages : []

    if (!user_id) {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid user_id' }),
        { headers: { 'Content-Type': 'application/json' }, status: 400 }
      )
    }
    if (messages.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Missing or empty messages' }),
        { headers: { 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    const openaiApiKey = Deno.env.get('OPENAI_API_KEY')
    if (!openaiApiKey) {
      return new Response(
        JSON.stringify({ error: 'Service configuration error' }),
        { headers: { 'Content-Type': 'application/json' }, status: 500 }
      )
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const systemPrompt = buildSystemPrompt()

    // Pass user + assistant messages to preserve conversation context for follow-up questions
    const openaiMessages: OpenAIMessage[] = messages
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
    const answer_text = (lastAssistant?.content ?? '').trim() || null

    const voice_enabled = body?.voice_enabled === true
    let audio_base64: string | null = null
    if (voice_enabled && answer_text) {
      audio_base64 = await textToSpeechBase64(openaiApiKey, answer_text)
    }

    // Only return user + assistant messages (no internal tool rounds)
    const safeMessages = resultMessages.filter((m) => m.role === 'user' || m.role === 'assistant')

    const payload: {
      messages: OpenAIMessage[]
      answer_text?: string | null
      audio_base64?: string | null
    } = {
      messages: safeMessages,
    }
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
