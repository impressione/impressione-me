import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildEmailBody,
  buildEmailHtml,
  escapeHtml,
  sendNewContactEmail,
} from "../workers/app/contact-consumer.js";

const contact = {
  email: "a@b.com",
  name: "Ada",
  company: "Acme",
  interest: "X",
  message: "Oi\nSegunda linha",
  submittedAt: "t",
  source: "s",
};

describe("contact email html", () => {
  it("escapes html in all fields", () => {
    assert.equal(
      escapeHtml(`<a href="x">&'`),
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;",
    );
    const html = buildEmailHtml({
      ...contact,
      name: "<b>Ada</b>",
      message: "<script>alert(1)</script>",
    });
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes("&lt;script&gt;"));
  });

  it("preserves newlines in message", () => {
    const html = buildEmailHtml(contact);
    assert.ok(html.includes("Oi<br>Segunda linha"));
  });

  it("keeps text version unchanged + sends html alongside", async () => {
    assert.match(buildEmailBody(contact), /Email: a@b\.com/);
    const sent = [];
    const env = {
      FROM_EMAIL: "f",
      TEAM_EMAIL: "t",
      EMAIL: { send: async (msg) => sent.push(msg) },
    };
    await sendNewContactEmail(env, contact);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].html.includes("mailto:a@b.com"));
    assert.ok(sent[0].text.includes("Email: a@b.com"));
    assert.equal(sent[0].replyTo, "a@b.com");
  });

  it("includes the automatic reply in the team notification", () => {
    const reply = {
      status: "sent",
      model: "@cf/meta/llama-4-scout-17b-16e-instruct",
      subject: "Re: contato",
      body: "Oi Ada, obrigado pelo contato.",
      is_returning: 1,
      previous_contacts: 2,
      last_contact_at: "2026-10-01T10:00:00.000Z",
    };
    const text = buildEmailBody(contact, { reply });
    assert.match(text, /Resposta automatica/);
    assert.match(text, /Status: sent/);
    assert.match(text, /Oi Ada, obrigado pelo contato\./);
    assert.match(text, /Contato recorrente: 2/);

    const html = buildEmailHtml(contact, { reply });
    assert.ok(html.includes("Resposta automática"));
    assert.ok(html.includes("Oi Ada, obrigado pelo contato."));
    assert.ok(html.includes("recorrente (2 anterior"));
  });

  it("highlights a failed automatic reply for manual follow-up", () => {
    const reply = {
      status: "failed",
      model: null,
      body: null,
      reason: "reply-generation-failed",
      error: "llama: 429",
      is_returning: 0,
    };
    const text = buildEmailBody(contact, { reply });
    assert.match(text, /Status: failed/);
    assert.match(text, /llama: 429/);
    assert.match(text, /responder manualmente/i);

    const html = buildEmailHtml(contact, { reply });
    assert.ok(html.includes("Responder manualmente."));
    assert.ok(html.includes("llama: 429"));
  });
});
