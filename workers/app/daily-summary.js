// Resumo diário: agrega os contatos das últimas 24h em 1 e-mail.
// Inclui os contatos reais com a resposta automática enviada (ou a falha,
// quando o time precisa responder manualmente). Quando não há nada para
// analisar, o e-mail não é enviado (ver `hasDailyContent`).

import { escapeHtml } from "./contact-consumer.js";

const MAX_TEXT = 1200;

function truncate(value, limit = MAX_TEXT) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export async function queryPendingReview(db, sinceIso) {
  const countsRow = await db
    .prepare(
      `SELECT classification AS type, COUNT(*) AS n FROM contacts
       WHERE submittedAt >= ?
       GROUP BY classification`,
    )
    .bind(sinceIso)
    .all();

  const itemsRow = await db
    .prepare(
      `SELECT submittedAt, email, name, classification, confidence, reason,
              substr(message, 1, 160) AS excerpt
       FROM contacts
       WHERE submittedAt >= ? AND classification != 'real_contact'
       ORDER BY submittedAt DESC LIMIT 20`,
    )
    .bind(sinceIso)
    .all();

  const repliedRow = await db
    .prepare(
      `SELECT c.submittedAt, c.email, c.name, c.message,
              r.status AS reply_status, r.model AS reply_model,
              r.subject AS reply_subject, r.body AS reply_body,
              r.is_returning, r.previous_contacts, r.last_contact_at,
              r.sent_at AS reply_sent_at, r.reason AS reply_reason,
              r.error AS reply_error
       FROM contacts c
       LEFT JOIN contact_replies r ON r.contact_id = c.id
       WHERE c.submittedAt >= ? AND c.classification = 'real_contact'
       ORDER BY c.submittedAt DESC LIMIT 20`,
    )
    .bind(sinceIso)
    .all();

  const counts = {};
  for (const row of countsRow.results ?? []) {
    counts[row.type] = row.n;
  }

  return {
    counts,
    items: itemsRow.results ?? [],
    replied: repliedRow.results ?? [],
  };
}

export function hasDailyContent({ items = [], replied = [] } = {}) {
  return items.length > 0 || replied.length > 0;
}

const TYPE_LABELS = {
  real_contact: "reais",
  spam: "spam",
  phishing_scam: "phishing",
  suspicious_language: "idioma",
  unclassified: "pendentes",
};

const TYPE_SINGULAR = {
  real_contact: "real",
};

function typeCountLabel(type, n) {
  const label = (n === 1 && TYPE_SINGULAR[type]) || TYPE_LABELS[type] || type;
  return `${n} ${label}`;
}

function replyStatusLabel(item) {
  if (!item.reply_status) return "sem resposta registrada";
  if (item.reply_status === "sent") return "enviada";
  if (item.reply_status === "failed") return "falhou";
  return item.reply_status;
}

function replyHistoryLabel(item) {
  if (!item.is_returning) return "primeiro contato";
  return `recorrente (${item.previous_contacts ?? 0} anterior(es), última em ${item.last_contact_at || "-"})`;
}

export function buildDailySummaryEmail({ day, counts = {}, items = [], replied = [] }) {
  const parts = Object.entries(counts).map(
    ([type, n]) => typeCountLabel(type, n),
  );

  const lines = [
    `Resumo de contatos — ${day}`,
    "",
    parts.length > 0 ? parts.join(" · ") : "Nada a revisar nas últimas 24h.",
    "",
  ];

  if (replied.length > 0) {
    lines.push("Contatos reais e resposta automática:");
    for (const item of replied) {
      lines.push(
        `- [${item.submittedAt}] ${item.email} (${item.name || "-"}) :: ${replyStatusLabel(item)}${item.reply_model ? ` · ${item.reply_model}` : ""}`,
      );
      lines.push(`  historico: ${replyHistoryLabel(item)}`);
      lines.push(`  mensagem: ${truncate(item.message)}`);
      if (item.reply_body) lines.push(`  resposta: ${truncate(item.reply_body)}`);
      if (item.reply_error || item.reply_reason) {
        lines.push(`  erro: ${item.reply_error || item.reply_reason}`);
      }
    }
    lines.push("");
  }

  if (items.length > 0) {
    lines.push("Para revisar:");
    for (const item of items) {
      lines.push(
        `- [${item.submittedAt}] ${item.email} (${item.name || "-"}) :: ${item.classification} (conf ${item.confidence ?? "-"})`,
      );
      if (item.reason) lines.push(`  motivo: ${item.reason}`);
      if (item.excerpt) lines.push(`  trecho: ${item.excerpt}`);
    }
  } else if (replied.length === 0) {
    lines.push("Nada a revisar nas últimas 24h.");
  }

  const subject =
    parts.length > 0
      ? `Resumo diário de contatos (${parts.join(" · ")})`
      : "Resumo diário de contatos (nada a revisar)";

  const repliedRows = replied
    .map((item) => {
      const failed = item.reply_status === "failed";
      const reply = item.reply_body
        ? escapeHtml(truncate(item.reply_body)).replaceAll("\n", "<br>")
        : failed
          ? `<span style="color:#a33;">${escapeHtml(item.reply_error || item.reply_reason || "falha na geração")}</span>`
          : "-";
      return [
        `<tr><td style="padding:6px 8px;border:1px solid #e2e2e2;vertical-align:top;">${escapeHtml(item.submittedAt)}</td>`,
        `<td style="padding:6px 8px;border:1px solid #e2e2e2;vertical-align:top;"><a href="mailto:${escapeHtml(item.email)}">${escapeHtml(item.email)}</a><br><span style="color:#666;">${escapeHtml(item.name || "-")}</span><br><span style="color:#666;">${escapeHtml(replyHistoryLabel(item))}</span></td>`,
        `<td style="padding:6px 8px;border:1px solid #e2e2e2;vertical-align:top;">${escapeHtml(truncate(item.message)).replaceAll("\n", "<br>")}</td>`,
        `<td style="padding:6px 8px;border:1px solid #e2e2e2;vertical-align:top;"><strong>${escapeHtml(replyStatusLabel(item))}</strong>${item.reply_model ? `<br><span style="color:#666;">${escapeHtml(item.reply_model)}</span>` : ""}<br>${reply}</td></tr>`,
      ].join("");
    })
    .join("");

  const itemRows = items
    .map(
      (item) => [
        `<tr><td style="padding:6px 8px;border:1px solid #e2e2e2;">${escapeHtml(item.submittedAt)}</td>`,
        `<td style="padding:6px 8px;border:1px solid #e2e2e2;"><a href="mailto:${escapeHtml(item.email)}">${escapeHtml(item.email)}</a><br><span style="color:#666;">${escapeHtml(item.name || "-")}</span></td>`,
        `<td style="padding:6px 8px;border:1px solid #e2e2e2;">${escapeHtml(item.classification)}<br><span style="color:#666;">conf ${escapeHtml(item.confidence ?? "-")}</span></td>`,
        `<td style="padding:6px 8px;border:1px solid #e2e2e2;">${item.reason ? `${escapeHtml(item.reason)}<br>` : ""}<span style="color:#666;">${escapeHtml(item.excerpt || "")}</span></td></tr>`,
      ].join(""),
    )
    .join("");

  const html = [
    `<div style="font-family:Arial,Helvetica,sans-serif;max-width:720px;color:#222;">`,
    `<h2 style="margin:0 0 4px;">Resumo de contatos — ${escapeHtml(day)}</h2>`,
    `<p style="color:#666;">${parts.length > 0 ? escapeHtml(parts.join(" · ")) : "Nada a revisar nas últimas 24h."}</p>`,
    replied.length > 0
      ? [
          `<h3 style="margin:16px 0 6px;">Contatos reais e resposta automática</h3>`,
          `<table style="border-collapse:collapse;width:100%;">`,
          `<tr style="background:#f6f6f6;"><th style="padding:6px 8px;border:1px solid #e2e2e2;text-align:left;">Quando</th><th style="padding:6px 8px;border:1px solid #e2e2e2;text-align:left;">Quem</th><th style="padding:6px 8px;border:1px solid #e2e2e2;text-align:left;">Mensagem</th><th style="padding:6px 8px;border:1px solid #e2e2e2;text-align:left;">Resposta automática</th></tr>`,
          repliedRows,
          `</table>`,
        ].join("")
      : "",
    items.length > 0
      ? [
          `<h3 style="margin:16px 0 6px;">Para revisar</h3>`,
          `<table style="border-collapse:collapse;width:100%;">`,
          `<tr style="background:#f6f6f6;"><th style="padding:6px 8px;border:1px solid #e2e2e2;text-align:left;">Quando</th><th style="padding:6px 8px;border:1px solid #e2e2e2;text-align:left;">Quem</th><th style="padding:6px 8px;border:1px solid #e2e2e2;text-align:left;">Classe</th><th style="padding:6px 8px;border:1px solid #e2e2e2;text-align:left;">Detalhe</th></tr>`,
          itemRows,
          `</table>`,
        ].join("")
      : "",
    `</div>`,
  ].join("");

  return { subject, text: lines.join("\n"), html };
}
