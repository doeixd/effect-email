ALTER TABLE effect_email_delivery_intents
  ADD COLUMN IF NOT EXISTS claim_expires_at TEXT;

CREATE INDEX IF NOT EXISTS effect_email_delivery_intents_outbox
  ON effect_email_delivery_intents
  (status, queued_at, tenant_id, delivery_id);

CREATE INDEX IF NOT EXISTS effect_email_delivery_intents_claim
  ON effect_email_delivery_intents
  (status, claim_expires_at);
