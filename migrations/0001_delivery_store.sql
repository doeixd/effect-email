CREATE TABLE IF NOT EXISTS effect_email_delivery_intents (
  delivery_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  queued_at TEXT,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS effect_email_delivery_events (
  event_id TEXT PRIMARY KEY,
  delivery_id TEXT,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  data TEXT NOT NULL
);

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
