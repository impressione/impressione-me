import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  queryPendingReview,
  buildDailySummaryEmail,
  hasDailyContent,
} from "../workers/app/daily-summary.js";

// Fake mínimo da API D1: prepare(sql).bind(...).all() -> { results }.
function fakeDb({ counts = [], items = [], replied = [] } = {}) {
  return {
    prepare: (sql) => ({
      bind: () => ({
        all: async () => ({
          results: sql.includes("GROUP BY")
            ? counts
            : sql.includes("contact_replies")
              ? replied
              : items,
        }),
      }),
    }),
  };
}

const repliedContact = {
  submittedAt: "2026-10-10T10:00:00.000Z",
  email: "maria@example.com",
  name: "Maria",
  message: "Preciso de um sistema de estoque",
  reply_status: "sent",
  reply_model: "@cf/meta/llama-4-scout-17b-16e-instruct",
  reply_subject: "Re: contato pelo site impressione.me",
  reply_body: "Oi Maria, obrigado pelo contato. Qual o tamanho da operação?",
  is_returning: 1,
  previous_contacts: 2,
  last_contact_at: "2026-10-01T10:00:00.000Z",
  reply_error: null,
  reply_reason: null,
};

describe("daily summary", () => {
  it("builds subject + body with counts, review items and auto replies", () => {
    const { subject, text, html } = buildDailySummaryEmail({
      day: "2026-10-10",
      counts: { real_contact: 1, spam: 2, phishing_scam: 1, suspicious_language: 1, unclassified: 1 },
      items: [
        {
          submittedAt: "t", email: "a@b.com", name: "<A>",
          classification: "phishing_scam", confidence: 0.93,
          reason: "", excerpt: "conta bloqueada",
        },
      ],
      replied: [repliedContact],
    });
    assert.match(subject, /1 real/);
    assert.match(subject, /2 spam/);
    assert.match(subject, /1 phishing/);
    assert.match(subject, /1 idioma/);
    assert.match(text, /a@b\.com/);
    assert.match(text, /conta bloqueada/);
    assert.match(text, /Contatos reais e resposta automática/);
    assert.match(text, /maria@example\.com/);
    assert.match(text, /Preciso de um sistema de estoque/);
    assert.match(text, /obrigado pelo contato/);
    assert.match(text, /recorrente \(2 anterior/);
    assert.ok(html.includes("<table"));
    assert.ok(html.includes("mailto:a@b.com"));
    assert.ok(html.includes("mailto:maria@example.com"));
    assert.ok(!html.includes("<A>"));
    assert.ok(html.includes("&lt;A&gt;"));
  });

  it("failed auto reply appears as failure instead of body", () => {
    const { text, html } = buildDailySummaryEmail({
      day: "d",
      counts: { real_contact: 1 },
      items: [],
      replied: [
        {
          ...repliedContact,
          reply_status: "failed",
          reply_body: null,
          reply_error: "resend 422: domain not verified",
        },
      ],
    });
    assert.match(text, /falhou/);
    assert.match(text, /domain not verified/);
    assert.ok(html.includes("domain not verified"));
  });

  it("empty day -> no content, queries separate real contacts", async () => {
    const seen = [];
    const db = {
      prepare: (sql) => ({
        bind: (...args) => {
          seen.push(sql);
          return { all: async () => ({ results: [] }) };
        },
      }),
    };
    const { counts, items, replied } = await queryPendingReview(db, "2026-10-09T00:00:00.000Z");
    assert.deepEqual(counts, {});
    assert.deepEqual(items, []);
    assert.deepEqual(replied, []);
    assert.equal(hasDailyContent({ items, replied }), false);

    const nonReal = seen.find((sql) => sql.includes("substr(message"));
    assert.ok(nonReal.includes("!= 'real_contact'"));
    const realQuery = seen.find((sql) => sql.includes("contact_replies"));
    assert.ok(realQuery.includes("classification = 'real_contact'"));

    const { text } = buildDailySummaryEmail({ day: "d", counts, items, replied });
    assert.match(text, /Nada a revisar/);
  });

  it("auto-replied real contact alone still counts as content", () => {
    assert.equal(hasDailyContent({ items: [], replied: [repliedContact] }), true);
    const { subject, text } = buildDailySummaryEmail({
      day: "d",
      counts: { real_contact: 1 },
      items: [],
      replied: [repliedContact],
    });
    assert.match(subject, /1 real/);
    assert.doesNotMatch(text, /Nada a revisar/);
  });
});
