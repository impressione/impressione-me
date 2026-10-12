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
});
