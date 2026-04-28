// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

Deno.serve(async (req) => {
  try {
    // Get Supabase client using service role key (bypasses RLS for no-auth operations)
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Optionally pick up session_id / device_id from the request body and
    // persist them on the new users row's *_legacy columns. The current iOS
    // build does NOT send a body (the MVP insert was empty {}), so missing /
    // empty / malformed bodies are tolerated -- this branch only fires for
    // future iOS builds (M4) that start sending these fields.
    let sessionIdLegacy: string | null = null
    let deviceIdLegacy: string | null = null
    const body = await req.json().catch(() => null) as
      | { session_id?: unknown; device_id?: unknown }
      | null
    if (body && typeof body === 'object') {
      if (typeof body.session_id === 'string' && body.session_id.length > 0) {
        sessionIdLegacy = body.session_id
      }
      if (typeof body.device_id === 'string' && body.device_id.length > 0) {
        deviceIdLegacy = body.device_id
      }
    }

    // Create user record in the new public.users table (replaces public.anonymous_users
    // from MVP, archived in archive.anonymous_users_v1_mvp). id and created_at
    // auto-populate via column DEFAULTs.
    const { data, error } = await supabase
      .from('users')
      .insert({
        session_id_legacy: sessionIdLegacy,
        device_id_legacy: deviceIdLegacy,
      })
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
        error: error.message || 'Failed to create user'
      }),
      {
        headers: { "Content-Type": "application/json" },
        status: 500
      },
    )
  }
})
