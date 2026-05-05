import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  if (req.method === 'GET') {
    try {
      const url = new URL(req.url)
      const user_id = url.searchParams.get('user_id')

      if (!user_id || user_id.length === 0) {
        return new Response(
          JSON.stringify({ error: 'user_id query parameter is required' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        )
      }

      const supabaseUrl = Deno.env.get('SUPABASE_URL')!
      const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
      const supabase = createClient(supabaseUrl, supabaseServiceKey)

      const { data, error } = await supabase
        .from('users')
        .select('id, name, name_updated_at')
        .eq('id', user_id)
        .maybeSingle()

      if (error) {
        console.error('update_user_profile GET error:', error)
        return new Response(
          JSON.stringify({ error: 'Failed to read profile', details: error.message }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        )
      }

      if (!data) {
        return new Response(
          JSON.stringify({ error: 'User not found' }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        )
      }

      return new Response(
        JSON.stringify({
          id: data.id,
          name: data.name,
          name_updated_at: data.name_updated_at,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    } catch (err) {
      console.error('update_user_profile GET unexpected error:', err)
      return new Response(
        JSON.stringify({ error: 'Internal server error' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      )
    }
  }

  if (req.method !== 'POST' && req.method !== 'PATCH') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { 'Content-Type': 'application/json' } },
    )
  }

  try {
    const body = await req.json().catch(() => null)
    if (!body) {
      return new Response(
        JSON.stringify({ error: 'Invalid JSON body' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const { user_id, name } = body

    if (!user_id || typeof user_id !== 'string') {
      return new Response(
        JSON.stringify({ error: 'user_id is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }

    if (!name || typeof name !== 'string') {
      return new Response(
        JSON.stringify({ error: 'name is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const trimmed = name.trim()
    if (trimmed.length === 0) {
      return new Response(
        JSON.stringify({ error: 'name cannot be empty' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }

    if (trimmed.length > 100) {
      return new Response(
        JSON.stringify({ error: 'name must be 100 characters or fewer' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const { data, error } = await supabase
      .from('users')
      .update({ name: trimmed, name_updated_at: new Date().toISOString() })
      .eq('id', user_id)
      .select('id, name, name_updated_at')
      .maybeSingle()

    if (error) {
      console.error('update_user_profile error:', error)
      return new Response(
        JSON.stringify({ error: 'Failed to update profile', details: error.message }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      )
    }

    if (!data) {
      return new Response(
        JSON.stringify({ error: 'User not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      )
    }

    return new Response(
      JSON.stringify({
        id: data.id,
        name: data.name,
        name_updated_at: data.name_updated_at,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )

  } catch (err) {
    console.error('update_user_profile unexpected error:', err)
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
})
