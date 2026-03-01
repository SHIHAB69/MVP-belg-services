1. **Run the stack locally (all functions):**

1. From project root, start Supabase (DB, API, Auth, Storage, etc.):
   ```bash
   supabase start
   ```
2. In another terminal, serve Edge Functions with env vars (no JWT for local):
   ```bash
   supabase functions serve --no-verify-jwt --env-file .env.local
   ```
   Or put secrets in `supabase/functions/.env` — that file is auto-loaded when serving.
3. Base URL for functions: `http://127.0.0.1:54321/functions/v1/<name>`
   Functions: `register`, `upload`, `ask`, `chat`, `realtime-session`, `documents`, `document-file`.
   Ensure `.env.local` (or `supabase/functions/.env`) has `OPENAI_API_KEY` for `ask`, `chat`, `realtime-session`.

---

**LOCAL** (base URL: `http://127.0.0.1:54321/functions/v1`)

1. REGISTER - Create Anonymous User
curl -X POST 'http://127.0.0.1:54321/functions/v1/register' \
  --header 'Content-Type: application/json'

2. UPLOAD - Upload Document with OCR Text
curl -X POST 'http://127.0.0.1:54321/functions/v1/upload' \
  --header 'Content-Type: application/json' \
  --form 'user_id=YOUR_USER_ID_HERE' \
  --form 'raw_text=Starbucks Coffee $5.50 on 2024-01-24' \
  --form 'file=@/path/to/your/receipt.jpg'

3. ASK - Query Expenses (single-turn)
curl -X POST 'http://127.0.0.1:54321/functions/v1/ask' \
  --header 'Content-Type: application/json' \
  --data '{"user_id": "YOUR_USER_ID_HERE", "question": "What is my total spending?"}'

4. CHAT - Multi-turn chat with tools (optional voice)
# Text only:
curl -X POST 'http://127.0.0.1:54321/functions/v1/chat' \
  --header 'Content-Type: application/json' \
  --data '{
    "user_id": "YOUR_USER_ID_HERE",
    "messages": [{"role": "user", "content": "How much did I spend at Starbucks?"}]
  }'
# With TTS (returns answer_text + audio_base64):
curl -X POST 'http://127.0.0.1:54321/functions/v1/chat' \
  --header 'Content-Type: application/json' \
  --data '{
    "user_id": "YOUR_USER_ID_HERE",
    "messages": [{"role": "user", "content": "What is my total spending this month?"}],
    "voice_enabled": true
  }'

5. REALTIME-SESSION - Create OpenAI realtime session (ephemeral token)
curl -X POST 'http://127.0.0.1:54321/functions/v1/realtime-session' \
  --header 'Content-Type: application/json' \
  --data '{"user_id": "YOUR_USER_ID_HERE"}'

6. DOCUMENTS - List (GET) or delete (DELETE) a document
# List:
curl 'http://127.0.0.1:54321/functions/v1/documents?user_id=YOUR_USER_ID_HERE&limit=20'
# Delete (removes file from storage and DB record; cascade removes transaction/OCR):
curl -X DELETE 'http://127.0.0.1:54321/functions/v1/documents?user_id=YOUR_USER_ID_HERE&id=DOCUMENT_UUID_HERE'
# Or with JSON body:
curl -X DELETE 'http://127.0.0.1:54321/functions/v1/documents?user_id=YOUR_USER_ID_HERE' \
  --header 'Content-Type: application/json' \
  --data '{"document_id": "DOCUMENT_UUID_HERE"}'

7. DOCUMENT-FILE - Fetch receipt/document file (image or PDF) for display in Receipt section
curl 'http://127.0.0.1:54321/functions/v1/document-file?user_id=YOUR_USER_ID_HERE&id=DOCUMENT_UUID_HERE' \
  --output receipt.jpg
# Or use the URL in app: GET this URL to get raw file bytes; display in <img src="..."> or PDF viewer.

---

**PROD** (base URL: `https://amngfletxzqaokmhccxe.supabase.co/functions/v1`)

1. REGISTER - Create Anonymous User
curl -X POST 'https://amngfletxzqaokmhccxe.supabase.co/functions/v1/register' \  --header 'Content-Type: application/json'
2. UPLOAD - Upload Document with OCR Text
curl -X POST 'https://amngfletxzqaokmhccxe.supabase.co/functions/v1/upload' \  --header 'Authorization: Bearer YOUR_ANON_KEY_HERE' \  --form 'user_id=YOUR_USER_ID_HERE' \  --form 'raw_text=Starbucks Coffee $5.50 on 2024-01-24' \  --form 'file=@/path/to/your/receipt.jpg'
3. ASK - Query Expenses (single-turn)
curl -X POST 'https://amngfletxzqaokmhccxe.supabase.co/functions/v1/ask' \
  --header 'Authorization: Bearer YOUR_ANON_KEY_HERE' \
  --header 'Content-Type: application/json' \
  --data '{"user_id": "YOUR_USER_ID_HERE", "question": "What is my total spending?"}'

4. CHAT - Multi-turn chat with tools (optional voice)
curl -X POST 'https://amngfletxzqaokmhccxe.supabase.co/functions/v1/chat' \
  --header 'Authorization: Bearer YOUR_ANON_KEY_HERE' \
  --header 'Content-Type: application/json' \
  --data '{"user_id": "YOUR_USER_ID_HERE", "messages": [{"role": "user", "content": "How much did I spend?"}], "voice_enabled": false}'

5. REALTIME-SESSION - Create OpenAI realtime session (ephemeral token)
curl -X POST 'https://amngfletxzqaokmhccxe.supabase.co/functions/v1/realtime-session' \
  --header 'Authorization: Bearer YOUR_ANON_KEY_HERE' \
  --header 'Content-Type: application/json' \
  --data '{"user_id": "YOUR_USER_ID_HERE"}'

6. DOCUMENTS - List (GET) or delete (DELETE)
curl 'https://amngfletxzqaokmhccxe.supabase.co/functions/v1/documents?user_id=YOUR_USER_ID_HERE&limit=20'
# Delete:
curl -X DELETE 'https://amngfletxzqaokmhccxe.supabase.co/functions/v1/documents?user_id=YOUR_USER_ID_HERE&id=DOCUMENT_UUID_HERE' \
  --header 'Authorization: Bearer YOUR_ANON_KEY_HERE'

7. DOCUMENT-FILE - Fetch receipt/document file for Receipt section (image or PDF)
curl -o receipt.jpg 'https://amngfletxzqaokmhccxe.supabase.co/functions/v1/document-file?user_id=YOUR_USER_ID_HERE&id=DOCUMENT_UUID_HERE' \
  --header 'Authorization: Bearer YOUR_ANON_KEY_HERE'
