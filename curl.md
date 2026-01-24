1. REGISTER - Create Anonymous User
curl -X POST 'http://127.0.0.1:54321/functions/v1/register' \  --header 'Content-Type: application/json'
Note: Run supabase functions serve register --no-verify-jwt first to bypass Kong.

2. UPLOAD - Upload Document with OCR Text
http://127.0.0.1:54321/
curl -X POST 'http://127.0.0.1:54321/functions/v1/upload' \  --header 'Authorization: Bearer sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH' \  --form 'user_id=YOUR_USER_ID_HERE' \  --form 'raw_text=Starbucks Coffee $5.50 on 2024-01-24' \  --form 'file=@/path/to/your/receipt.jpg'


3. ASK - Query Expenses
spend
curl -X POST 'http://127.0.0.1:54321/functions/v1/ask' \  --header 'Authorization: Bearer sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH' \  --header 'Content-Type: application/json' \  --data '{    "user_id": "YOUR_USER_ID_HERE",    "question": "What is my total spending?"  }'

PROD

1. REGISTER - Create Anonymous User
curl -X POST 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/register' \  --header 'Content-Type: application/json'
2. UPLOAD - Upload Document with OCR Text
curl -X POST 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/upload' \  --header 'Authorization: Bearer YOUR_ANON_KEY_HERE' \  --form 'user_id=YOUR_USER_ID_HERE' \  --form 'raw_text=Starbucks Coffee $5.50 on 2024-01-24' \  --form 'file=@/path/to/your/receipt.jpg'
3. ASK - Query Expenses
curl -X POST 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/ask' \  --header 'Authorization: Bearer YOUR_ANON_KEY_HERE' \  --header 'Content-Type: application/json' \  --data '{    "user_id": "YOUR_USER_ID_HERE",    "question": "What is my total spending?"  }'
