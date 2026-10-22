ALTER TABLE effect_email_delivery_intents
  ADD COLUMN IF NOT EXISTS status TEXT;

ALTER TABLE effect_email_delivery_intents
  ADD COLUMN IF NOT EXISTS updated_at TEXT;

ALTER TABLE effect_email_delivery_intents
  ADD COLUMN IF NOT EXISTS queued_at TEXT;

ALTER TABLE effect_email_delivery_events
  ADD COLUMN IF NOT EXISTS event_type TEXT;

ALTER TABLE effect_email_delivery_events
  ADD COLUMN IF NOT EXISTS occurred_at TEXT;

UPDATE effect_email_delivery_intents
SET
  status = COALESCE(
    status,
    data::jsonb ->> 'status',
    'pending'
  ),
  updated_at = COALESCE(
    updated_at,
    data::jsonb -> 'updatedAt' ->> '__effect_email_datetime__',
    to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ),
  queued_at = COALESCE(
    queued_at,
    data::jsonb -> 'queuedAt' ->> '__effect_email_datetime__'
  );

UPDATE effect_email_delivery_events
SET
  event_type = COALESCE(
    event_type,
    data::jsonb ->> 'type',
    'unknown'
  ),
  occurred_at = COALESCE(
    occurred_at,
    data::jsonb -> 'occurredAt' ->> '__effect_email_datetime__',
    to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );

ALTER TABLE effect_email_delivery_intents
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE effect_email_delivery_events
  ALTER COLUMN event_type SET NOT NULL,
  ALTER COLUMN occurred_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS effect_email_delivery_intents_status
  ON effect_email_delivery_intents (status);

CREATE INDEX IF NOT EXISTS effect_email_delivery_intents_updated
  ON effect_email_delivery_intents (updated_at);

CREATE INDEX IF NOT EXISTS effect_email_delivery_events_delivery
  ON effect_email_delivery_events (delivery_id);

CREATE INDEX IF NOT EXISTS effect_email_delivery_events_type
  ON effect_email_delivery_events (event_type);

CREATE INDEX IF NOT EXISTS effect_email_delivery_events_occurred
  ON effect_email_delivery_events (occurred_at);
