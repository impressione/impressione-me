// Resumo diário: agrega contatos não-reais das últimas 24h em 1 e-mail.

import { escapeHtml } from "./contact-consumer.js";
export async function queryPendingReview(db, sinceIso) {
  const countsRow = await db
    .prepare(
      `SELECT classification AS type, COUNT(*) AS n FROM contacts
       WHERE submittedAt >= ? AND classification != 'real_contact'
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

  const counts = {};
  for (const row of countsRow.results ?? []) {
    counts[row.type] = row.n;
  }
  return { counts, items: itemsRow.results ?? [] };
}

const TYPE_LABELS = {
  real_contact: "reais",
  spam: "spam",
  phishing_scam: "phishing",
  suspicious_language: "idioma",
  unclassified: "pendentes",
};

export function buildDailySummaryEmail({ day, counts, items }) {
  const parts = Object.entries(counts).map(
    ([type, n]) => `${n} ${TYPE_LABELS[type] ?? type}`,
  );

  const lines = [
    `Resumo de contatos — ${day}`,
    "",
    parts.length > 0 ? parts.join(" · ") : "Nada a revisar nas últimas 24h.",
    "",
  ];

  if (items.length === 0) {
    lines.push("Nada a revisar nas últimas 24h.");
  } else {
    for (const item of items) {
      lines.push(
        `- [${item.submittedAt}] ${item.email} (${item.name || "-"}) :: ${item.classification} (conf ${item.confidence ?? "-"})`,
      );
      if (item.reason) lines.push(`  motivo: ${item.reason}`);
      if (item.excerpt) lines.push(`  trecho: ${item.excerpt}`);
    }
  }

  const subject =
    parts.length > 0
      ? `Resumo diário de contatos (${parts.join(" · ")})`
      : "Resumo diário de contatos (nada a revisar)";

  const itemRows =
    items.length === 0
      ? `<p>Nada a revisar nas últimas 24h.</p>`
      : items
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
    `<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;color:#222;">`,
    `<h2 style="margin:0 0 4px;">Resumo de contatos — ${escapeHtml(day)}</h2>`,
    `<p style="color:#666;">${parts.length > 0 ? escapeHtml(parts.join(" · ")) : "Nada a revisar nas últimas 24h."}</p>`,
    `<table style="border-collapse:collapse;width:100%;">`,
    `<tr style="background:#f6f6f6;"><th style="padding:6px 8px;border:1px solid #e2e2e2;text-align:left;">Quando</th><th style="padding:6px 8px;border:1px solid #e2e2e2;text-align:left;">Quem</th><th style="padding:6px 8px;border:1px solid #e2e2e2;text-align:left;">Classe</th><th style="padding:6px 8px;border:1px solid #e2e2e2;text-align:left;">Detalhe</th></tr>`,
    itemRows,
    `</table></div>`,
  ].join("");

  return { subject, text: lines.join("\n"), html };
}
