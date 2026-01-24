// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

Deno.serve(async (req) => {
  try {
    // Get Supabase client using service role key (bypasses RLS for no-auth operations)
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Create anonymous user record
    // created_at is automatically set via DEFAULT NOW() in the schema
    const { data, error } = await supabase
      .from('anonymous_users')
      .insert({})
      .select('id, created_at')
      .single()

    if (error) {
      throw error
    }

    // Return the UUID and created_at timestamp
    return new Response(
      JSON.stringify({ 
        id: data.id,
        created_at: data.created_at
      }),
      { 
        headers: { "Content-Type": "application/json" },
        status: 201
      },
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ 
        error: error.message || 'Failed to create anonymous user' 
      }),
      { 
        headers: { "Content-Type": "application/json" },
        status: 500
      },
    )
  }
})
