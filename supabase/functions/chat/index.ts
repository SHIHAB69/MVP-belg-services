// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

// ---------------------------------------------------------------------------
// Tool names and definitions (no get_last_transaction; use get_recent_transactions(limit 1))
// ---------------------------------------------------------------------------

const TOOL_NAMES = [
  'get_total_spending',
  'get_spending_by_merchant',
  'get_recent_transactions',
  'get_total_income',
] as const

const OPENAI_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'get_total_spending',
      description: "Get the user's total spending between two dates (inclusive). Dates must be ISO 8601 (YYYY-MM-DD).",
      parameters: {
        type: 'object' as const,
        properties: {
          start_date: { type: 'string' as const, description: 'Start date inclusive (YYYY-MM-DD)' },
          end_date: { type: 'string' as const, description: 'End date inclusive (YYYY-MM-DD)' },
        },
        required: ['start_date', 'end_date'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_spending_by_merchant',
      description: "Get total spending for a specific merchant (case-insensitive match).",
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
      description: "Get the user's transactions ordered by document upload time (first item = most recently uploaded). Use limit 1 ONLY for 'last transaction' or 'my last transaction'. For 'transaction history', 'all my transactions', or 'list my transactions' use limit 50 to return the full list. Returns amount, currency, merchant, category, transaction_date, description. The first transaction in the list is the most recently uploaded.",
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
      name: 'get_total_income',
      description: "Get the user's total income for a given calendar year (sum of transaction amounts where transaction_date falls in that year).",
      parameters: {
        type: 'object' as const,
        properties: {
          year: { type: 'number' as const, description: 'Calendar year (e.g. 2026)' },
        },
        required: ['year'],
        additionalProperties: false,
      },
    },
  },
]

// ---------------------------------------------------------------------------
// Tool execution (Supabase)
// ---------------------------------------------------------------------------

type ToolResult = { content: string }

async function runGetTotalSpending(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  startDate: string,
  endDate: string
): Promise<ToolResult> {
  const { data: docs } = await supabase
    .from('documents')
    .select('id')
    .eq('user_id', userId)
  if (!docs?.length) {
    return { content: JSON.stringify({ total: 0, message: 'No documents.' }) }
  }
  const docIds = docs.map((d) => d.id)
  const { data: rows, error } = await supabase
    .from('transactions')
    .select('amount')
    .in('document_id', docIds)
    .gte('transaction_date', startDate)
    .lte('transaction_date', endDate)
  if (error) {
    return { content: JSON.stringify({ error: error.message }) }
  }
  const total = rows?.reduce((sum, t) => sum + parseFloat(t.amount), 0) ?? 0
  return { content: JSON.stringify({ total, start_date: startDate, end_date: endDate }) }
}

async function runGetSpendingByMerchant(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  merchant: string
): Promise<ToolResult> {
  const { data: docs } = await supabase
    .from('documents')
    .select('id')
    .eq('user_id', userId)
  if (!docs?.length) {
    return { content: JSON.stringify({ total: 0, merchant, message: 'No documents.' }) }
  }
  const docIds = docs.map((d) => d.id)
  const { data: rows, error } = await supabase
    .from('transactions')
    .select('amount, merchant')
    .in('document_id', docIds)
  if (error) {
    return { content: JSON.stringify({ error: error.message }) }
  }
  const needle = merchant.toLowerCase()
  const total = (rows ?? [])
    .filter((t) => (t.merchant ?? '').toLowerCase().includes(needle))
    .reduce((sum, t) => sum + parseFloat(t.amount), 0)
  return { content: JSON.stringify({ total, merchant }) }
}

/** Recent = by document upload time (most recently uploaded receipt first). */
async function runGetRecentTransactions(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  limit: number
): Promise<ToolResult> {
  const capped = Math.min(50, Math.max(1, Math.round(limit)))
  const { data: docList } = await supabase
    .from('documents')
    .select('id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50)
  if (!docList?.length) {
    return { content: JSON.stringify({ transactions: [], message: 'No documents.' }) }
  }
  const docIds = docList.map((d) => d.id)
  const { data: txRows, error } = await supabase
    .from('transactions')
    .select('document_id, amount, currency, merchant, category, transaction_date, description')
    .in('document_id', docIds)
  if (error) {
    return { content: JSON.stringify({ error: error.message }) }
  }
  const byDocOrder = (a: { document_id: string }, b: { document_id: string }) =>
    docIds.indexOf(a.document_id) - docIds.indexOf(b.document_id)
  const sorted = (txRows ?? []).slice().sort(byDocOrder).slice(0, capped)
  const transactions = sorted.map((t) => ({
    amount: t.amount,
    currency: t.currency ?? null,
    merchant: t.merchant ?? null,
    category: t.category ?? null,
    transaction_date: t.transaction_date ?? null,
    description: t.description ?? null,
  }))
  return {
    content: JSON.stringify({
      transactions,
      note: 'Ordered by most recent upload first. First item is the user\'s last uploaded transaction.',
    }),
  }
}

async function runGetTotalIncome(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  year: number
): Promise<ToolResult> {
  const start = `${year}-01-01`
  const end = `${year}-12-31`
  const { data: docs } = await supabase
    .from('documents')
    .select('id')
    .eq('user_id', userId)
  if (!docs?.length) {
    return { content: JSON.stringify({ total: 0, year, message: 'No documents.' }) }
  }
  const docIds = docs.map((d) => d.id)
  const { data: rows, error } = await supabase
    .from('transactions')
    .select('amount')
    .in('document_id', docIds)
    .gte('transaction_date', start)
    .lte('transaction_date', end)
  if (error) {
    return { content: JSON.stringify({ error: error.message }) }
  }
  const total = rows?.reduce((sum, t) => sum + parseFloat(t.amount), 0) ?? 0
  return { content: JSON.stringify({ total, year }) }
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<ToolResult> {
  switch (name) {
    case 'get_total_spending': {
      const start = typeof args.start_date === 'string' ? args.start_date : ''
      const end = typeof args.end_date === 'string' ? args.end_date : ''
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
    case 'get_total_income': {
      const year = typeof args.year === 'number' ? args.year : new Date().getFullYear()
      return runGetTotalIncome(supabase, userId, year)
    }
    default:
      return { content: JSON.stringify({ error: `Unknown tool: ${name}` }) }
  }
}

// ---------------------------------------------------------------------------
// System prompt (current date + last-transaction rule)
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  const now = new Date()
  const currentYear = now.getFullYear()
  const currentDate = now.toISOString().split('T')[0]
  return `You are a helpful expense-tracking assistant. Today's date is ${currentDate} (year ${currentYear}).

Strict rules:
- Answer ONLY from tool results. Never use information from previous messages for transaction lists, "last transaction", or totals—data may have changed. Always call the appropriate tool for the current question.
- For "last transaction", "my last transaction", or "most recent transaction": you MUST call get_recent_transactions with limit 1. Report the first (and only) transaction returned. Do not use conversation history or a previous tool result for this.
- For "transaction history", "all my transactions", "list my transactions", or "my transactions": you MUST call get_recent_transactions with limit 50 (not 2 or 5) so the user sees their full list. Report all transactions returned by the tool.
- If a tool returns empty data or an error, say clearly that the information is unavailable. Do not guess.
- Keep answers concise and text-only; do not instruct the app to show or filter UI.`
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
        model: 'gpt-4o-mini',
        messages: all,
        tools: OPENAI_TOOLS.length ? OPENAI_TOOLS : undefined,
        tool_choice: OPENAI_TOOLS.length ? 'auto' : undefined,
        max_tokens: 500,
        temperature: 0.3,
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
      messages?: Array<{ role: string; content: string }>
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
    const openaiMessages: OpenAIMessage[] = messages.map((m) => ({
      role: m.role as 'user' | 'assistant' | 'system',
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

    const payload: {
      messages: OpenAIMessage[]
      answer_text?: string | null
      audio_base64?: string | null
    } = {
      messages: resultMessages,
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
