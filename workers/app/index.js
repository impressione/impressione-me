import { handleContact } from "./contact-producer.js";
import { handleQueue } from "./contact-consumer.js";
import { ensureSchema } from "./db.js";
import {
  queryPendingReview,
  buildDailySummaryEmail,
  hasDailyContent,
} from "./daily-summary.js";

// ContactWorkflow mora em módulo próprio (importa "cloudflare:workers",
// indisponível no node:test). Import dinâmico com fallback para os testes.
let ContactWorkflow = class {};
try {
  ({ ContactWorkflow } = await import("./contact-workflow.js"));
} catch {
  // node:test — wiring do workflow validado em preview, não aqui.
}

export { ContactWorkflow };

function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

async function handleScheduled(env) {
  await ensureSchema(env.DB);

  const day = utcDay();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { counts, items, replied } = await queryPendingReview(env.DB, since);

  // Sem contato para analisar (nem real respondido): não envia e não grava
  // o guard do dia — o próximo cron com conteúdo ainda pode enviar.
  if (!hasDailyContent({ items, replied })) {
    console.log(`Daily summary for ${day}: nothing to review, skipping`);
    return;
  }

  const guard = await env.DB.prepare(
    "INSERT OR IGNORE INTO daily_summary (day, sent_at, counts) VALUES (?, ?, '{}')",
  )
    .bind(day, new Date().toISOString())
    .run();

  if (guard.meta.changes === 0) {
    console.log(`Daily summary for ${day} already sent, skipping`);
    return;
  }

  const { subject, text, html } = buildDailySummaryEmail({ day, counts, items, replied });

  await env.EMAIL.send({
    from: env.FROM_EMAIL,
    to: env.TEAM_EMAIL,
    subject,
    text,
    html,
    replyTo: env.FROM_EMAIL,
  });

  await env.DB.prepare("UPDATE daily_summary SET counts = ? WHERE day = ?")
    .bind(JSON.stringify(counts), day)
    .run();
  console.log(`Daily summary sent for ${day}: ${subject}`);
}

export default {
  async queue(batch, env) {
    await handleQueue(batch, env);
  },
  async scheduled(event, env) {
    await handleScheduled(env);
  },
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/contact") {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: { Allow: "POST, OPTIONS" },
        });
      }
      if (request.method === "POST") {
        return handleContact(request, env);
      }
      return new Response("Method Not Allowed", { status: 405 });
    }

    return env.ASSETS.fetch(request);
  },
};
