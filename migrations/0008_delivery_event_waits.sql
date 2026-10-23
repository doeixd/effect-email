CREATE TABLE IF NOT EXISTS effect_email_delivery_event_waits (
  execution_id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS effect_email_delivery_event_waits_delivery
  ON effect_email_delivery_event_waits (delivery_id);
