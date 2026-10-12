import { ensureSchema } from "./db.js";

function normalize(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildEmailBody(fields) {
  const lines = [
    "Novo contato pelo formulario de impressione.me",
    "",
    `Email: ${fields.email}`,
    `Nome: ${fields.name || "-"}`,
    `Empresa: ${fields.company || "-"}`,
    `Interesse: ${fields.interest || "-"}`,
    `Enviado em: ${fields.submittedAt || "-"}`,
    `Origem: ${fields.source || "-"}`,
    "",
    "Mensagem:",
    fields.message || "-",
  ];

  return lines.join("\n");
}

export function buildEmailHtml(fields) {
  const row = (label, value) =>
    `<tr><td style="padding:6px 12px 6px 0;color:#666;white-space:nowrap;vertical-align:top;">${label}</td><td style="padding:6px 0;vertical-align:top;">${escapeHtml(value || "-")}</td></tr>`;
  const message = escapeHtml(fields.message || "-").replaceAll("\n", "<br>");

  return [
    `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;color:#222;">`,
    `<h2 style="margin:0 0 4px;">Novo contato pelo formulário de impressione.me</h2>`,
    `<table style="border-collapse:collapse;margin:12px 0;">`,
    row("Email", fields.email),
    row("Nome", fields.name),
    row("Empresa", fields.company),
    row("Interesse", fields.interest),
    row("Enviado em", fields.submittedAt),
    row("Origem", fields.source),
    `</table>`,
    `<p style="margin:12px 0 4px;color:#666;">Mensagem:</p>`,
    `<div style="background:#f6f6f6;border:1px solid #e2e2e2;border-radius:6px;padding:12px;">${message}</div>`,
    `<p style="margin:12px 0 0;"><a href="mailto:${escapeHtml(fields.email)}">Responder ao visitante</a></p>`,
    `</div>`,
  ].join("");
}

export function sanitizeSubmission(body) {
  return {
    email: normalize(body?.email),
    name: normalize(body?.name),
    company: normalize(body?.company),
    interest: normalize(body?.interest),
    message: normalize(body?.message),
    submittedAt: normalize(body?.submittedAt),
    source: normalize(body?.source),
  };
}

export async function sendNewContactEmail(env, contact, subject) {
  await env.EMAIL.send({
    from: env.FROM_EMAIL,
    to: env.TEAM_EMAIL,
    subject: subject ?? `Novo contato de ${contact.email}`,
    text: buildEmailBody(contact),
    html: buildEmailHtml(contact),
    replyTo: contact.email,
  });
}

// Consumer fino: dedupe + dispara 1 instância do workflow por contato.
// O processamento durável (classificar → rotear) mora no ContactWorkflow.
export async function handleQueue(batch, env) {
  await ensureSchema(env.DB);

  for (const message of batch.messages) {
    const submission = sanitizeSubmission(message.body);

    if (!submission.email) {
      continue;
    }

    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO contacts
       (email, name, company, interest, message, submittedAt, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        submission.email,
        submission.name,
        submission.company,
        submission.interest,
        submission.message,
        submission.submittedAt,
        submission.source || "website-contact-form",
      )
      .run();

    if (inserted.meta.changes === 0) {
      console.log("Duplicate delivery, skipping workflow");
      continue;
    }

    const contactId = inserted.meta.last_row_id;
    if (!Number.isInteger(contactId)) {
      console.log("Insert without row id, skipping workflow");
      continue;
    }
    await env.CONTACT_WORKFLOW.create({
      id: `contact-${contactId}`,
      params: { contactId },
    });
    console.log(`Workflow started for contact ${contactId}`);
  }
}
