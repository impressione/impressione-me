// Histórico de contatos agrupado por email. O email é a chave: o mesmo
// endereço pode enviar vários formulários e a resposta automática muda de
// tom conforme o tempo desde a última interação.
//
// Consultas usam `LOWER(email)` para aproveitar `idx_contacts_email`
// (índice de expressão criado na migration 0002) e `id <` como critério de
// "anterior" — mais estável que comparar timestamps no replay do workflow.

export function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

const EMPTY_HISTORY = {
  email: "",
  previousAny: 0,
  previousReal: 0,
  lastContactAt: null,
  lastRealContactAt: null,
  lastMessages: [],
};

export async function loadContactHistory(db, contact) {
  const email = normalizeEmail(contact?.email);
  const contactId = Number(contact?.id);

  if (!email || !Number.isInteger(contactId)) {
    return { ...EMPTY_HISTORY, email };
  }

  const summary = await db
    .prepare(
      `SELECT COUNT(*) AS previous_any,
              SUM(CASE WHEN classification = 'real_contact' THEN 1 ELSE 0 END) AS previous_real,
              MAX(submittedAt) AS last_contact_at,
              MAX(CASE WHEN classification = 'real_contact' THEN submittedAt END) AS last_real_contact_at
       FROM contacts
       WHERE LOWER(email) = ? AND id < ?`,
    )
    .bind(email, contactId)
    .first();

  const recent = await db
    .prepare(
      `SELECT submittedAt, classification, substr(message, 1, 400) AS message
       FROM contacts
       WHERE LOWER(email) = ? AND id < ?
       ORDER BY submittedAt DESC, id DESC
       LIMIT 3`,
    )
    .bind(email, contactId)
    .all();

  return {
    email,
    previousAny: Number(summary?.previous_any ?? 0),
    previousReal: Number(summary?.previous_real ?? 0),
    lastContactAt: summary?.last_contact_at ?? null,
    lastRealContactAt: summary?.last_real_contact_at ?? null,
    lastMessages: (recent?.results ?? []).map((row) => ({
      submittedAt: row.submittedAt,
      classification: row.classification,
      message: row.message,
    })),
  };
}
