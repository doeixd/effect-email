ALTER TABLE effect_email_delivery_intents
  ADD COLUMN IF NOT EXISTS tenant_id TEXT;

UPDATE effect_email_delivery_intents
SET tenant_id = data::jsonb ->> 'tenantId'
WHERE tenant_id IS NULL
  AND data::jsonb ? 'tenantId';

CREATE INDEX IF NOT EXISTS effect_email_delivery_intents_tenant
  ON effect_email_delivery_intents (tenant_id, delivery_id);
