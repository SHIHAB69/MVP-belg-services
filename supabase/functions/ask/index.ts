// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

// Deterministic query types
type QueryType = 
  | 'total_all'
  | 'total_today'
  | 'total_this_week'
  | 'total_this_month'
  | 'total_by_category'
  | 'recent_transactions'
  | 'unknown'

// Detect query type from question text
function detectQueryType(question: string): QueryType {
  const lowerQuestion = question.toLowerCase()
  
  // Total queries
  if (lowerQuestion.match(/\b(total|spent|spending|sum|how much)\b/)) {
    if (lowerQuestion.match(/\b(today|todays)\b/)) return 'total_today'
    if (lowerQuestion.match(/\b(this week|week|weekly)\b/)) return 'total_this_week'
    if (lowerQuestion.match(/\b(this month|month|monthly)\b/)) return 'total_this_month'
    if (lowerQuestion.match(/\b(category|categories|by category)\b/)) return 'total_by_category'
    return 'total_all'
  }
  
  // Recent transactions
  if (lowerQuestion.match(/\b(recent|latest|last|recently|show me|list|what are)\b/)) {
    if (lowerQuestion.match(/\b(transaction|expense|purchase|spending)\b/)) {
      return 'recent_transactions'
    }
  }
  
  return 'unknown'
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
        const { data: docs } = await supabase
          .from('documents')
          .select('id')
          .eq('user_id', userId)
        
        if (!docs || docs.length === 0) {
          return "You don't have any transactions yet."
        }
        
        const docIds = docs.map(d => d.id)
        const { data, error } = await supabase
          .from('transactions')
          .select('amount')
          .in('document_id', docIds)
        
        if (error) throw error
        const total = data?.reduce((sum, t) => sum + parseFloat(t.amount), 0) || 0
        return `Your total spending is $${total.toFixed(2)}.`
      }
      
      case 'total_today': {
        const today = new Date().toISOString().split('T')[0]
        const { data: docs } = await supabase
          .from('documents')
          .select('id')
          .eq('user_id', userId)
        
        if (!docs || docs.length === 0) {
          return "You haven't made any transactions today."
        }
        
        const docIds = docs.map(d => d.id)
        const { data, error } = await supabase
          .from('transactions')
          .select('amount')
          .in('document_id', docIds)
          .eq('transaction_date', today)
        
        if (error) throw error
        const total = data?.reduce((sum, t) => sum + parseFloat(t.amount), 0) || 0
        return `You've spent $${total.toFixed(2)} today.`
      }
      
      case 'total_this_week': {
        const weekAgo = new Date()
        weekAgo.setDate(weekAgo.getDate() - 7)
        const { data: docs } = await supabase
          .from('documents')
          .select('id')
          .eq('user_id', userId)
          .gte('created_at', weekAgo.toISOString())
        
        if (!docs || docs.length === 0) {
          return "You haven't made any transactions this week."
        }
        
        const docIds = docs.map(d => d.id)
        const { data, error } = await supabase
          .from('transactions')
          .select('amount')
          .in('document_id', docIds)
        
        if (error) throw error
        const total = data?.reduce((sum, t) => sum + parseFloat(t.amount), 0) || 0
        return `You've spent $${total.toFixed(2)} this week.`
      }
      
      case 'total_this_month': {
        const monthAgo = new Date()
        monthAgo.setMonth(monthAgo.getMonth() - 1)
        const { data: docs } = await supabase
          .from('documents')
          .select('id')
          .eq('user_id', userId)
          .gte('created_at', monthAgo.toISOString())
        
        if (!docs || docs.length === 0) {
          return "You haven't made any transactions this month."
        }
        
        const docIds = docs.map(d => d.id)
        const { data, error } = await supabase
          .from('transactions')
          .select('amount')
          .in('document_id', docIds)
        
        if (error) throw error
        const total = data?.reduce((sum, t) => sum + parseFloat(t.amount), 0) || 0
        return `You've spent $${total.toFixed(2)} this month.`
      }
      
      case 'total_by_category': {
        const { data: docs } = await supabase
          .from('documents')
          .select('id')
          .eq('user_id', userId)
        
        if (!docs || docs.length === 0) {
          return "You don't have any transactions yet."
        }
        
        const docIds = docs.map(d => d.id)
        const { data, error } = await supabase
          .from('transactions')
          .select('category, amount')
          .in('document_id', docIds)
          .not('category', 'is', null)
        
        if (error) throw error
        
        const categoryTotals: Record<string, number> = {}
        data?.forEach(t => {
          const cat = t.category || 'Uncategorized'
          categoryTotals[cat] = (categoryTotals[cat] || 0) + parseFloat(t.amount)
        })
        
        if (Object.keys(categoryTotals).length === 0) {
          return "You don't have any categorized transactions yet."
        }
        
        const summary = Object.entries(categoryTotals)
          .map(([cat, total]) => `${cat}: $${total.toFixed(2)}`)
          .join(', ')
        
        return `Spending by category: ${summary}.`
      }
      
      case 'recent_transactions': {
        const { data: docs } = await supabase
          .from('documents')
          .select('id')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(10)
        
        if (!docs || docs.length === 0) {
          return "You don't have any transactions yet."
        }
        
        const docIds = docs.map(d => d.id)
        const { data, error } = await supabase
          .from('transactions')
          .select('amount, merchant, category, transaction_date, description')
          .in('document_id', docIds)
          .order('created_at', { ascending: false })
          .limit(5)
        
        if (error) throw error
        
        if (!data || data.length === 0) {
          return "You don't have any parsed transactions yet."
        }
        
        const transactions = data.map(t => {
          const parts = [
            `$${parseFloat(t.amount).toFixed(2)}`,
            t.merchant ? `at ${t.merchant}` : '',
            t.category ? `(${t.category})` : '',
            t.transaction_date ? `on ${t.transaction_date}` : ''
          ].filter(Boolean).join(' ')
          return `- ${parts}`
        }).join('\n')
        
        return `Your recent transactions:\n${transactions}`
      }
      
      default:
        return null
    }
  } catch (error) {
    console.error('Deterministic query error:', error)
    return null
  }
}

// Call LLM API for complex questions
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
            content: `You are a helpful expense tracking assistant. Answer questions about the user's expenses based on the following context:\n\n${context}\n\nKeep answers concise and friendly.`
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
    // Get Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Parse request body
    const { user_id, question } = await req.json()

    if (!user_id || !question) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: user_id and question' }),
        {
          headers: { "Content-Type": "application/json" },
          status: 400
        },
      )
    }

    // Detect query type
    const queryType = detectQueryType(question)
    
    let answer_text: string

    // Try deterministic query first
    if (queryType !== 'unknown') {
      const deterministicAnswer = await executeDeterministicQuery(supabase, user_id, queryType)
      if (deterministicAnswer) {
        answer_text = deterministicAnswer
      } else {
        // Deterministic query failed, fall back to LLM
        // Get some context about user's transactions
        const { data: recentDocs } = await supabase
          .from('documents')
          .select('id')
          .eq('user_id', user_id)
          .order('created_at', { ascending: false })
          .limit(5)
        
        const docIds = recentDocs?.map(d => d.id) || []
        const { data: recentTransactions } = await supabase
          .from('transactions')
          .select('amount, merchant, category, transaction_date')
          .in('document_id', docIds)
          .limit(10)
        
        const context = recentTransactions && recentTransactions.length > 0
          ? `Recent transactions: ${JSON.stringify(recentTransactions)}`
          : "User has no transactions yet."
        
        answer_text = await callLLM(question, context)
      }
    } else {
      // Unknown query type, use LLM
      // Get context for LLM
      const { data: recentDocs } = await supabase
        .from('documents')
        .select('id')
        .eq('user_id', user_id)
        .order('created_at', { ascending: false })
        .limit(5)
      
      const docIds = recentDocs?.map(d => d.id) || []
      const { data: recentTransactions } = await supabase
        .from('transactions')
        .select('amount, merchant, category, transaction_date')
        .in('document_id', docIds)
        .limit(10)
      
      const context = recentTransactions && recentTransactions.length > 0
        ? `Recent transactions: ${JSON.stringify(recentTransactions)}`
        : "User has no transactions yet."
      
      answer_text = await callLLM(question, context)
    }

    return new Response(
      JSON.stringify({
        answer_text,
        query_type: queryType
      }),
      {
        headers: { "Content-Type": "application/json" },
        status: 200
      },
    )
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed to process question',
        answer_text: "I'm sorry, I encountered an error processing your question."
      }),
      {
        headers: { "Content-Type": "application/json" },
        status: 500
      },
    )
  }
})
