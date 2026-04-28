// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

// Deterministic query types (UNCHANGED from MVP)
type QueryType =
  | 'total_all'
  | 'total_today'
  | 'total_this_week'
  | 'total_this_month'
  | 'total_by_category'
  | 'recent_transactions'
  | 'unknown'

// Detect query type from question text -- regex patterns UNCHANGED from MVP.
// Same input string -> same QueryType. Don't extend; new query types are M4.
function detectQueryType(question: string): QueryType {
  const lowerQuestion = question.toLowerCase().trim()

  if (lowerQuestion.match(/^(what|how much|show me|tell me|give me)\s+(is|are|was|were|did|do|can|will)\s+(my|the)\s+(total|spent|spending|sum)/i) ||
      lowerQuestion.match(/^(what|how much)\s+(is|are|was|were)\s+(my|the)\s+(total|spent|spending)/i)) {
    if (lowerQuestion.match(/\b(today|todays)\b/)) return 'total_today'
    if (lowerQuestion.match(/\b(this week|week|weekly)\b/)) return 'total_this_week'
    if (lowerQuestion.match(/\b(this month|month|monthly)\b/)) return 'total_this_month'
    if (lowerQuestion.match(/\b(category|categories|by category)\b/)) return 'total_by_category'
    return 'total_all'
  }

  if (lowerQuestion.match(/^(show|list|tell me|give me|what are)\s+(me\s+)?(my\s+)?(recent|latest|last)\s+(transaction|expense|purchase)/i) ||
      lowerQuestion.match(/^(what|which)\s+(are|were)\s+(my\s+)?(recent|latest|last)\s+(transaction|expense|purchase)/i)) {
    return 'recent_transactions'
  }

  return 'unknown'
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

// Each user-data fetch returns documents carrying their own transactions, the
// matching subtype (receipts or invoices), and -- for receipts -- the linked
// store. flattenDocument converts these into MVP-shaped transaction records.
type FlatTx = {
  amount: number
  currency: string
  merchant: string | null
  category: string | null
  description: string | null
  transaction_date: string | null
  document_created_at: string
}

function flattenDocument(d: any): FlatTx[] {
  const txArr: any[] = Array.isArray(d.transactions) ? d.transactions : (d.transactions ? [d.transactions] : [])
  const receipt = Array.isArray(d.receipts) ? (d.receipts[0] ?? null) : (d.receipts ?? null)
  const invoice = Array.isArray(d.invoices) ? (d.invoices[0] ?? null) : (d.invoices ?? null)
  const subtype = receipt ?? invoice
  const store = receipt?.stores ?? null               // invoices have no store yet (Decision 14)
  return txArr.map((tx: any) => ({
    amount:           coalesceNum(tx.amount_corrected,           tx.amount_ocr),
    currency:         coalesceStr(tx.currency_corrected,         tx.currency_ocr) ?? 'USD',
    merchant:         coalesceStr(store?.name_corrected,         store?.name_ocr),
    category:         coalesceStr(subtype?.category_corrected,   subtype?.category_ocr),
    description:      coalesceStr(subtype?.description_corrected, subtype?.description_ocr),
    transaction_date: coalesceStr(tx.transaction_date_corrected, tx.transaction_date_ocr),
    document_created_at: d.created_at,
  }))
}

// One-round-trip embed -- documents + their transactions + subtype + store.
const USER_DATA_SELECT = `
  id, created_at,
  transactions (
    amount_ocr, amount_corrected,
    currency_ocr, currency_corrected,
    transaction_date_ocr, transaction_date_corrected
  ),
  receipts (
    category_ocr, category_corrected,
    description_ocr, description_corrected,
    stores ( name_ocr, name_corrected )
  ),
  invoices (
    category_ocr, category_corrected,
    description_ocr, description_corrected
  )
`

async function fetchUserDocs(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  options: { sinceCreatedAt?: string; orderRecentDesc?: boolean; limit?: number } = {}
) {
  let q = supabase.from('documents').select(USER_DATA_SELECT).eq('user_id', userId)
  if (options.sinceCreatedAt) q = q.gte('created_at', options.sinceCreatedAt)
  if (options.orderRecentDesc) q = q.order('created_at', { ascending: false })
  if (options.limit) q = q.limit(options.limit)
  const { data, error } = await q
  if (error) throw error
  return data ?? []
}

// Execute deterministic SQL queries
async function executeDeterministicQuery(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  queryType: QueryType
): Promise<string | null> {
  try {
    switch (queryType) {
      case 'total_all': {
        const docs = await fetchUserDocs(supabase, userId)
        if (docs.length === 0) return "You don't have any transactions yet."
        const total = docs.flatMap(flattenDocument).reduce((s, t) => s + t.amount, 0)
        return `Your total spending is $${total.toFixed(2)}.`
      }

      case 'total_today': {
        const today = new Date().toISOString().split('T')[0]
        const docs = await fetchUserDocs(supabase, userId)
        if (docs.length === 0) return "You haven't made any transactions today."
        // Filter on COALESCE(corrected, ocr) -- done in JS (Supabase JS .or() is awkward for this).
        const total = docs.flatMap(flattenDocument)
                          .filter(t => t.transaction_date === today)
                          .reduce((s, t) => s + t.amount, 0)
        return `You've spent $${total.toFixed(2)} today.`
      }

      case 'total_this_week': {
        const weekAgo = new Date()
        weekAgo.setDate(weekAgo.getDate() - 7)
        // NOTE: filters by document upload date (documents.created_at), not transaction_date.
        // This preserves MVP behaviour verbatim -- "fixing" it to use transaction_date
        // would change observable user-visible totals.
        const docs = await fetchUserDocs(supabase, userId, { sinceCreatedAt: weekAgo.toISOString() })
        if (docs.length === 0) return "You haven't made any transactions this week."
        const total = docs.flatMap(flattenDocument).reduce((s, t) => s + t.amount, 0)
        return `You've spent $${total.toFixed(2)} this week.`
      }

      case 'total_this_month': {
        const monthAgo = new Date()
        monthAgo.setMonth(monthAgo.getMonth() - 1)
        // Same upload-date-not-transaction-date quirk as total_this_week. Preserved.
        const docs = await fetchUserDocs(supabase, userId, { sinceCreatedAt: monthAgo.toISOString() })
        if (docs.length === 0) return "You haven't made any transactions this month."
        const total = docs.flatMap(flattenDocument).reduce((s, t) => s + t.amount, 0)
        return `You've spent $${total.toFixed(2)} this month.`
      }

      case 'total_by_category': {
        const docs = await fetchUserDocs(supabase, userId)
        if (docs.length === 0) return "You don't have any transactions yet."
        const categorized = docs.flatMap(flattenDocument).filter(t => t.category !== null)
        if (categorized.length === 0) return "You don't have any categorized transactions yet."

        const categoryTotals: Record<string, number> = {}
        categorized.forEach(t => {
          const cat = t.category ?? 'Uncategorized'
          categoryTotals[cat] = (categoryTotals[cat] || 0) + t.amount
        })
        const summary = Object.entries(categoryTotals)
          .map(([cat, total]) => `${cat}: $${total.toFixed(2)}`)
          .join(', ')
        return `Spending by category: ${summary}.`
      }

      case 'recent_transactions': {
        // Old code: docs limit 10, transactions limit 5. For 1-tx-per-doc data
        // (everything in M2 scope) this yields the 5 most recent transactions.
        const docs = await fetchUserDocs(supabase, userId, { orderRecentDesc: true, limit: 10 })
        if (docs.length === 0) return "You don't have any transactions yet."
        const txs = docs.flatMap(flattenDocument).slice(0, 5)
        if (txs.length === 0) return "You don't have any parsed transactions yet."

        const formatted = txs.map(t => {
          const parts = [
            `$${t.amount.toFixed(2)}`,
            t.merchant ? `at ${t.merchant}` : '',
            t.category ? `(${t.category})` : '',
            t.transaction_date ? `on ${t.transaction_date}` : ''
          ].filter(Boolean).join(' ')
          return `- ${parts}`
        }).join('\n')

        return `Your recent transactions:\n${formatted}`
      }

      default:
        return null
    }
  } catch (error) {
    console.error('Deterministic query error:', error)
    return null
  }
}

// Call LLM API for complex questions -- UNCHANGED model, prompt, params.
async function callLLM(question: string, context: string): Promise<string> {
  const openaiApiKey = Deno.env.get('OPENAI_API_KEY')

  if (!openaiApiKey) {
    return "I'm sorry, I don't have access to advanced AI features right now. Please try asking about your total spending or recent transactions."
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiApiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a helpful expense tracking assistant. Answer ONLY from the data in the context below (from the user's uploaded documents). Never invent or guess numbers. If the context does not contain the requested information, say clearly that it is unavailable or missing. Give only a text answer; do not ask the app to filter or display things. Keep answers concise and friendly.\n\nContext:\n${context}`
          },
          {
            role: 'user',
            content: question
          }
        ],
        max_tokens: 200,
        temperature: 0.7
      })
    })

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.statusText}`)
    }

    const data = await response.json()
    return data.choices[0]?.message?.content || "I couldn't generate a response. Please try again."
  } catch (error) {
    console.error('LLM API error:', error)
    return "I'm having trouble processing your question right now. Please try again later."
  }
}

Deno.serve(async (req) => {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const { user_id, question } = await req.json()

    if (!user_id || !question) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: user_id and question' }),
        { headers: { "Content-Type": "application/json" }, status: 400 },
      )
    }

    const queryType = detectQueryType(question)
    let answer_text: string

    if (queryType !== 'unknown') {
      const deterministicAnswer = await executeDeterministicQuery(supabase, user_id, queryType)
      if (deterministicAnswer) {
        answer_text = deterministicAnswer
      } else {
        // Deterministic query path failed -- small LLM context (5 most recent docs).
        const recentDocs = await fetchUserDocs(supabase, user_id, { orderRecentDesc: true, limit: 5 })
        const recentTxs = recentDocs.flatMap(flattenDocument).slice(0, 10).map(t => ({
          amount: t.amount,
          merchant: t.merchant,
          category: t.category,
          transaction_date: t.transaction_date,
        }))
        const context = recentTxs.length > 0
          ? `Recent transactions: ${JSON.stringify(recentTxs)}`
          : "User has no transactions yet."
        answer_text = await callLLM(question, context)
      }
    } else {
      // Unknown query type -- comprehensive LLM context.
      const allDocs = await fetchUserDocs(supabase, user_id, { orderRecentDesc: true })
      const allTxs = allDocs.flatMap(flattenDocument)
      // Sort by transaction_date desc (matches old .order('transaction_date', { ascending: false })).
      // Nulls last.
      allTxs.sort((a, b) => (b.transaction_date ?? '').localeCompare(a.transaction_date ?? ''))

      const totalAmount = allTxs.reduce((s, t) => s + t.amount, 0)
      const categoryTotals: Record<string, number> = {}
      allTxs.forEach(t => {
        const cat = t.category ?? 'Uncategorized'
        categoryTotals[cat] = (categoryTotals[cat] || 0) + t.amount
      })

      let context = `User's expense data:\n`
      if (allTxs.length > 0) {
        context += `- Total transactions: ${allTxs.length}\n`
        context += `- Total spending: $${totalAmount.toFixed(2)}\n`
        if (Object.keys(categoryTotals).length > 0) {
          context += `- Spending by category: ${JSON.stringify(categoryTotals)}\n`
        }
        // Match old shape: { amount, merchant, category, description, transaction_date, currency }
        const recent10 = allTxs.slice(0, 10).map(t => ({
          amount: t.amount,
          merchant: t.merchant,
          category: t.category,
          description: t.description,
          transaction_date: t.transaction_date,
          currency: t.currency,
        }))
        context += `- Recent transactions (last 10): ${JSON.stringify(recent10)}\n`
      } else {
        context += "User has no transactions yet."
      }

      answer_text = await callLLM(question, context)
    }

    return new Response(
      JSON.stringify({ answer_text, query_type: queryType }),
      { headers: { "Content-Type": "application/json" }, status: 200 },
    )
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed to process question',
        answer_text: "I'm sorry, I encountered an error processing your question."
      }),
      { headers: { "Content-Type": "application/json" }, status: 500 },
    )
  }
})
