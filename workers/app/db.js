// Garante o schema em runtime (consumer + scheduled chamam antes de usar).
// Evita depender de `migrations apply` no deploy: o DDL é idempotente
// (IF NOT EXISTS) e o resultado é cacheado por isolate. O teste
// `db-schema.test.js` garante que este DDL é idêntico ao versionado em
// `migrations/` (usado pelo `db:migrate` manual).
//
// Detalhe: usa `db.batch()` de prepared statements — o mecanismo documentado
// para múltiplos statements (`db.exec()` rejeitou o DDL em produção).
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  interest TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  submittedAt TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'website-contact-form',
  classification TEXT NOT NULL DEFAULT 'unclassified',
  confidence REAL,
  reason TEXT,
  classified_at TEXT,
  emailed_at TEXT,
  UNIQUE(email, submittedAt)
);
CREATE INDEX IF NOT EXISTS idx_contacts_classified
  ON contacts(classification, submittedAt);
CREATE TABLE IF NOT EXISTS daily_summary (
  day TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL,
  counts TEXT NOT NULL DEFAULT '{}'
);
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
`;

export function getSchemaSql() {
  return SCHEMA_SQL;
}

export function splitStatements(sql) {
  return sql
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

let schemaPromise = null;

export function ensureSchema(db) {
  if (!schemaPromise) {
    schemaPromise = db
      .batch(splitStatements(SCHEMA_SQL).map((statement) => db.prepare(statement)))
      .catch((err) => {
        schemaPromise = null;
        throw err;
      });
  }
  return schemaPromise;
}

export function _resetSchemaForTests() {
  schemaPromise = null;
}
