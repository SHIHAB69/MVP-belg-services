-- Add ai_summary column to documents (AI-generated summary of raw_text/transcript)
ALTER TABLE documents ADD COLUMN IF NOT EXISTS ai_summary TEXT;
