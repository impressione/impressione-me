import { WorkflowEntrypoint } from "cloudflare:workers";
import { classifyContact } from "./contact-classifier.js";
import { sendNewContactEmail } from "./contact-consumer.js";
import { loadContactHistory } from "./contact-history.js";
import { decideAutoReply, generateAutoReply } from "./auto-reply.js";
import { saveReply, markReplySent, markReplyFailed } from "./contact-replies.js";
import { sendVisitorReply } from "./resend.js";

// Pipeline durável de 1 contato. Steps são memoizados: replay nunca
// re-executa efeito já gravado (sem e-mail duplicado em retry).
export class ContactWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { contactId } = event.payload;

    const load = () =>
      this.env.DB.prepare("SELECT * FROM contacts WHERE id = ?")
        .bind(contactId)
        .first();
    const contact = await step.do("load-contact", load);
    if (!contact) {
      return { skipped: "contact-not-found" };
    }

    // Histórico por email: usado para decidir o tom da resposta automática.
    const history = await step.do("load-history", () =>
      loadContactHistory(this.env.DB, contact),
    );

    const cls = await step.do(
      "classify",
      {
        retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
        timeout: "2 minutes",
      },
      () => classifyContact(this.env.AI, contact),
    );

    await step.do("record-classification", () =>
      this.env.DB.prepare(
        `UPDATE contacts SET classification = ?, confidence = ?, reason = ?,
         classified_at = ? WHERE id = ?`,
      )
        .bind(cls.type, cls.confidence, cls.reason, new Date().toISOString(), contactId)
        .run(),
    );

    if (cls.type === "real_contact") {
      const decision = decideAutoReply({ contact, history });

      const draft = await step.do(
        "generate-reply",
        {
          retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
          timeout: "2 minutes",
        },
        () => generateAutoReply(this.env.AI, { contact, history }),
      );

      // Grava antes de enviar: o UNIQUE(contact_id) garante 1 resposta por
      // contato mesmo em replay. Falha de geração fica registrada e o time
      // recebe o aviso para responder manualmente.
      const reply = await step.do("record-reply", () =>
        saveReply(this.env.DB, { contact, decision, draft }),
      );

      let replied = reply?.status === "sent";

      if (reply?.status === "pending") {
        try {
          await step.do(
            "send-reply",
            {
              retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
              timeout: "1 minute",
            },
            () =>
              sendVisitorReply(this.env, {
                to: contact.email,
                subject: reply.subject,
                text: draft.text,
                html: draft.html,
                replyTo: this.env.TEAM_EMAIL,
                idempotencyKey: `contact-${contactId}`,
              }),
          );
          await step.do("mark-reply-sent", () =>
            markReplySent(this.env.DB, contactId),
          );
          reply.status = "sent";
          replied = true;
        } catch (err) {
          const message = err?.message || String(err);
          console.log(`Auto-reply failed for contact ${contactId}: ${message}`);
          await step.do("mark-reply-failed", () =>
            markReplyFailed(this.env.DB, contactId, message),
          );
          reply.status = "failed";
          reply.error = message;
        }
      }

      await step.do("notify", () =>
        sendNewContactEmail(this.env, contact, undefined, { reply, history }),
      );
      await step.do("mark-emailed", () =>
        this.env.DB.prepare(
          "UPDATE contacts SET emailed_at = ? WHERE id = ?",
        )
          .bind(new Date().toISOString(), contactId)
          .run(),
      );
      return { emailed: true, replied, type: cls.type, tone: decision.tone };
    }

    // Não-real: encerra aqui; o contato aparece no resumo diário (cron).
    return { emailed: false, type: cls.type, via: "daily-summary" };
  }
}
