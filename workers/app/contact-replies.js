// Persistência das respostas automáticas. `contact_id` é UNIQUE, então um
// retry/replay do workflow nunca cria segunda resposta para o mesmo contato.

export async function saveReply(db, { contact, decision, draft, now = new Date() }) {
  const createdAt = now.toISOString();
  const status = draft?.ok ? "pending" : "failed";

  await db
    .prepare(
      `INSERT OR IGNORE INTO contact_replies
       (contact_id, email, status, is_returning, previous_contacts, last_contact_at,
        model, subject, body, reason, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      contact.id,
      contact.email,
      status,
      decision?.isReturning ? 1 : 0,
      decision?.previousContacts ?? 0,
      decision?.lastContactAt ?? null,
      draft?.model ?? null,
      draft?.subject ?? null,
      draft?.body || null,
      draft?.reason ?? null,
      draft?.error ?? null,
      createdAt,
    )
    .run();

  return db
    .prepare("SELECT * FROM contact_replies WHERE contact_id = ?")
    .bind(contact.id)
    .first();
}

export async function markReplySent(db, contactId, now = new Date()) {
  await db
    .prepare("UPDATE contact_replies SET status = 'sent', sent_at = ? WHERE contact_id = ?")
    .bind(now.toISOString(), contactId)
    .run();
}

export async function markReplyFailed(db, contactId, error) {
  await db
    .prepare("UPDATE contact_replies SET status = 'failed', error = ? WHERE contact_id = ?")
    .bind(String(error ?? "").slice(0, 500), contactId)
    .run();
}
