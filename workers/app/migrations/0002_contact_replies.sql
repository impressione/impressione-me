CREATE INDEX IF NOT EXISTS idx_contacts_email
  ON contacts(LOWER(email), submittedAt);

CREATE TABLE IF NOT EXISTS contact_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL UNIQUE,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  is_returning INTEGER NOT NULL DEFAULT 0,
  previous_contacts INTEGER NOT NULL DEFAULT 0,
  last_contact_at TEXT,
  model TEXT,
  subject TEXT,
  body TEXT,
  reason TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_contact_replies_email
  ON contact_replies(email, created_at);
