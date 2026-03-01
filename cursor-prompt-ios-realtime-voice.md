# Cursor prompt: Real-time voice-to-voice on chat screen (Webflow button)

Use this prompt in the **iOS app** (e.g. with Cursor) to implement OpenAI Realtime voice when the user taps the **Webflow button** on the chat screen.

**Important:** The **Webflow button** on the chat screen must start the real-time voice session. Do **not** use the existing voice/microphone button for this—that button is used for another purpose.

---

## Copy-paste prompt for Cursor (iOS)

Implement real-time voice-to-voice with OpenAI Realtime when the user taps the **Webflow button** on the chat screen (not the existing voice/mic button).

### Trigger
- **Button:** The Webflow button on the chat screen.
- **Action on tap:** Start an OpenAI Realtime voice session (user speaks, AI replies with voice in real time).

### Backend API (call this first)
- **Method:** POST  
- **URL (prod):** `https://amngfletxzqaokmhccxe.supabase.co/functions/v1/realtime-session`  
- **Headers:** `Authorization: Bearer <SUPABASE_ANON_KEY>`, `Content-Type: application/json`  
- **Body:** `{ "user_id": "<current_user_id>" }` — use the same anonymous user ID used elsewhere in the app (e.g. from register/auth).  
- **Success (200):** `{ "client_secret": "<ephemeral_token>", "session_id": "<optional>" }`  
- Use **only** `client_secret` for the next step. Do not expose it in the UI; use it once per session to connect to OpenAI.

### After you have `client_secret`
1. Request microphone permission if not already granted.
2. Connect to **OpenAI** (not Supabase) using that token:
   - Use **WebRTC** (recommended for iOS): create an RTCPeerConnection, add the device microphone as the local track, create a data channel named `oai-events` if you need events/transcripts.
   - Create an SDP offer, then **POST** it to `https://api.openai.com/v1/realtime/calls` with header `Authorization: Bearer <client_secret>` and `Content-Type: application/sdp`, body = raw SDP string.
   - Set the SDP answer from the response as the remote description. Once connected, the connection carries user mic → OpenAI and OpenAI voice → device speaker.
3. Play the AI’s audio stream to the speaker (e.g. attach the remote stream to your audio output).
4. When the user taps the Webflow button again (or a “Stop” control), close the WebRTC connection and do not reuse the same `client_secret`.

### UX
- First tap on Webflow button: start session (call backend → get token → connect WebRTC → show “Listening” or similar).
- Second tap / Stop: end session (close connection).
- If backend or WebRTC fails, show a short error (e.g. “Couldn’t start voice. Try again.”) and allow retry.
- Do **not** change the behavior of the existing voice/microphone button; that remains for its current purpose.

### Config
- **SUPABASE_ANON_KEY:** Same key used for other Supabase calls in the app.
- **Base URL for realtime-session:** `https://amngfletxzqaokmhccxe.supabase.co/functions/v1`

Implement this flow so that only the **Webflow button** on the chat screen starts and stops the real-time voice-to-voice session.
