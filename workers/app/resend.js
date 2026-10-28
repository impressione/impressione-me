// Envio da resposta automática ao visitante via Resend (free tier).
//
// Por que não `send_email`: o binding da Cloudflare só entrega para
// destinatários verificados na conta. Responder a um email arbitrário exige
// Email Sending (Workers Paid). O Resend cobre esse caso no plano free
// (3.000 emails/mês, 100/dia), então a notificação ao time continua no
// binding e só a resposta ao visitante passa por HTTP.

export const RESEND_ENDPOINT = "https://api.resend.com/emails";
export const RESEND_TIMEOUT_MS = 10_000;

export function isResendConfigured(env) {
  return Boolean(env?.RESEND_API_KEY);
}

export async function sendVisitorReply(env, { to, subject, text, html, replyTo, idempotencyKey }) {
  const apiKey = env?.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("RESEND_API_KEY não configurada");
  }

  const from = env.REPLY_FROM_EMAIL || env.FROM_EMAIL;
  if (!from) {
    throw new Error("REPLY_FROM_EMAIL/FROM_EMAIL não configurado");
  }
  if (!to) {
    throw new Error("destinatário ausente");
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }

  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text,
      html,
      reply_to: replyTo || env.TEAM_EMAIL || from,
    }),
    signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`resend ${response.status}: ${raw.slice(0, 300)}`);
  }

  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
