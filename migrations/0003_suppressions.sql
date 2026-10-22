CREATE TABLE IF NOT EXISTS effect_email_suppressions (
  tenant_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY (tenant_id, recipient)
);

CREATE INDEX IF NOT EXISTS effect_email_suppressions_expires
  ON effect_email_suppressions (expires_at);
