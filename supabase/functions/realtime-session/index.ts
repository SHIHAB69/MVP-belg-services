// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"

// ---------------------------------------------------------------------------
// Config: prompt version and finance guardrails (injected into session)
// ---------------------------------------------------------------------------

const prompt_version = '1.0.0'

function getFinanceGuardrailsInstructions(): string {
  return `You are a helpful expense-tracking assistant. Prompt version: ${prompt_version}.

Strict rules:
- Never invent financial numbers. All totals and amounts must come only from tool results.
- If a tool returns null, empty data, or error: say clearly that the information is unavailable. Do not guess or fill in.
- Do not estimate. Do not extrapolate. Use only the exact data returned by tools.
- Keep answers concise and friendly.`
}

// ---------------------------------------------------------------------------
// Tool definitions (same as /chat; no raw SQL exposed to the model)
// ---------------------------------------------------------------------------

const REALTIME_TOOLS = [
  {
    type: 'function' as const,
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
  {
    type: 'function' as const,
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
  {
    type: 'function' as const,
    name: 'get_recent_transactions',
    description: "Get the user's most recent transactions. Returns amount, merchant, category, transaction_date, description.",
    parameters: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number' as const, description: 'Number of transactions to return (1-50)' },
      },
      required: ['limit'],
      additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'get_total_income',
    description: "Get the user's total income for a given calendar year (sum of transaction amounts where transaction_date falls in that year).",
    parameters: {
      type: 'object' as const,
      properties: {
        year: { type: 'number' as const, description: 'Calendar year (e.g. 2024)' },
      },
      required: ['year'],
      additionalProperties: false,
    },
  },
]

// ---------------------------------------------------------------------------
// OpenAI Realtime session creation
// ---------------------------------------------------------------------------

const OPENAI_REALTIME_SESSIONS_URL = 'https://api.openai.com/v1/realtime/sessions'

type CreateSessionResult =
  | { ok: true; client_secret: string; session_id?: string }
  | { ok: false; error: string }

async function createRealtimeSession(openaiApiKey: string): Promise<CreateSessionResult> {
  const instructions = getFinanceGuardrailsInstructions()

  const body = {
    model: 'gpt-4o-realtime-preview-2024-12-17',
    instructions,
    tools: REALTIME_TOOLS,
    voice: 'alloy',
  }

  const response = await fetch(OPENAI_REALTIME_SESSIONS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openaiApiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errText = await response.text()
    console.error('OpenAI Realtime session error:', response.status, errText)
    return {
      ok: false,
      error: `OpenAI API error: ${response.status} ${response.statusText}`,
    }
  }

  let data: Record<string, unknown>
  try {
    data = await response.json()
  } catch {
    console.error('OpenAI Realtime session: invalid JSON response')
    return { ok: false, error: 'Invalid response from OpenAI' }
  }

  const client_secret = data.client_secret
  if (typeof client_secret !== 'string' || !client_secret) {
    console.error('OpenAI Realtime session: missing client_secret in response', data)
    return { ok: false, error: 'Missing client_secret in session response' }
  }

  const session_id = typeof data.id === 'string' ? data.id : undefined
  return { ok: true, client_secret, session_id }
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

    const body = await req.json().catch(() => ({}))
    const user_id = body?.user_id

    if (!user_id || typeof user_id !== 'string' || user_id.trim() === '') {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid user_id' }),
        { headers: { 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    const openaiApiKey = Deno.env.get('OPENAI_API_KEY')
    if (!openaiApiKey) {
      console.error('realtime-session: OPENAI_API_KEY not set')
      return new Response(
        JSON.stringify({ error: 'Service configuration error' }),
        { headers: { 'Content-Type': 'application/json' }, status: 500 }
      )
    }

    const result = await createRealtimeSession(openaiApiKey)

    if (!result.ok) {
      return new Response(
        JSON.stringify({ error: result.error }),
        { headers: { 'Content-Type': 'application/json' }, status: 502 }
      )
    }

    const payload: Record<string, string> = {
      client_secret: result.client_secret,
    }
    if (result.session_id) {
      payload.session_id = result.session_id
    }

    return new Response(JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (error) {
    console.error('realtime-session error:', error)
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed to create realtime session',
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})
