ALTER TABLE effect_email_delivery_intents
  ADD COLUMN IF NOT EXISTS provider_message_id TEXT;

UPDATE effect_email_delivery_intents
SET provider_message_id = data::jsonb -> 'receipt' ->> 'providerMessageId'
WHERE provider_message_id IS NULL
  AND data::jsonb -> 'receipt' ? 'providerMessageId';

CREATE INDEX IF NOT EXISTS effect_email_delivery_intents_provider_message
  ON effect_email_delivery_intents (provider_message_id);
