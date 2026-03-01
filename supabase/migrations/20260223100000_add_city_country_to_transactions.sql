-- Add city and country to transactions (structured fields per receipt)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS country TEXT;
