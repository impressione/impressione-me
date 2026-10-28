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

export function buildEmailBody(fields, extra = {}) {
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

  const reply = extra.reply;
  if (reply) {
    lines.push("", "Resposta automatica:");
    lines.push(`Status: ${reply.status || "-"}`);
    if (reply.model) lines.push(`Modelo: ${reply.model}`);
    if (reply.subject) lines.push(`Assunto: ${reply.subject}`);
    if (reply.is_returning) {
      lines.push(
        `Contato recorrente: ${reply.previous_contacts ?? 0} interacao(oes) anterior(es), ultima em ${reply.last_contact_at || "-"}`,
      );
    }
    if (reply.status === "failed") {
      lines.push(`Erro: ${reply.error || reply.reason || "falha na geracao"}`);
      lines.push("Acao: responder manualmente.");
    } else if (reply.body) {
      lines.push("", reply.body);
    }
  }

  return lines.join("\n");
}

export function buildEmailHtml(fields, extra = {}) {
  const row = (label, value) =>
    `<tr><td style="padding:6px 12px 6px 0;color:#666;white-space:nowrap;vertical-align:top;">${label}</td><td style="padding:6px 0;vertical-align:top;">${escapeHtml(value || "-")}</td></tr>`;
  const message = escapeHtml(fields.message || "-").replaceAll("\n", "<br>");
  const reply = extra.reply;
  const replyBlock = !reply
    ? ""
    : [
        `<p style="margin:16px 0 4px;color:#666;">Resposta automática:</p>`,
        `<div style="background:${reply.status === "failed" ? "#fdf0f0" : "#f6f6f6"};border:1px solid ${reply.status === "failed" ? "#e5b4b4" : "#e2e2e2"};border-radius:6px;padding:12px;">`,
        `<p style="margin:0 0 8px;color:#666;">Status: ${escapeHtml(reply.status || "-")}${reply.model ? ` · ${escapeHtml(reply.model)}` : ""}${reply.is_returning ? ` · recorrente (${escapeHtml(reply.previous_contacts ?? 0)} anterior(es), última em ${escapeHtml(reply.last_contact_at || "-")})` : ""}</p>`,
        reply.status === "failed"
          ? `<p style="margin:0;color:#a33;">${escapeHtml(reply.error || reply.reason || "falha na geração")}<br><strong>Responder manualmente.</strong></p>`
          : `<div style="white-space:pre-wrap;">${escapeHtml(reply.body || "-")}</div>`,
        `</div>`,
      ].join("");

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
    replyBlock,
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

export async function sendNewContactEmail(env, contact, subject, extra = {}) {
  await env.EMAIL.send({
    from: env.FROM_EMAIL,
    to: env.TEAM_EMAIL,
    subject: subject ?? `Novo contato de ${contact.email}`,
    text: buildEmailBody(contact, extra),
    html: buildEmailHtml(contact, extra),
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
