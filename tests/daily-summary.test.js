import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  queryPendingReview,
  buildDailySummaryEmail,
} from "../workers/app/daily-summary.js";

// Fake mínimo da API D1: prepare(sql).bind(...).all() -> { results }.
function fakeDb({ counts, items }) {
  return {
    prepare: (sql) => ({
      bind: () => ({
        all: async () => ({
          results: sql.includes("GROUP BY") ? counts : items,
        }),
      }),
    }),
  };
}

describe("daily summary", () => {
  it("builds subject + body with counts and items", () => {
    const { subject, text, html } = buildDailySummaryEmail({
      day: "2026-10-10",
      counts: { spam: 2, phishing_scam: 1, suspicious_language: 1, unclassified: 1 },
      items: [
        {
          submittedAt: "t", email: "a@b.com", name: "<A>",
          classification: "phishing_scam", confidence: 0.93,
          reason: "", excerpt: "conta bloqueada",
        },
      ],
    });
    assert.match(subject, /2 spam/);
    assert.match(subject, /1 phishing/);
    assert.match(subject, /1 idioma/);
    assert.match(text, /a@b\.com/);
    assert.match(text, /conta bloqueada/);
    assert.ok(html.includes("<table"));
    assert.ok(html.includes("mailto:a@b.com"));
    assert.ok(!html.includes("<A>"));
    assert.ok(html.includes("&lt;A&gt;"));
  });

  it("empty day -> heartbeat body, real contacts excluded by query", async () => {
    const seen = [];
    const db = {
      prepare: (sql) => ({
        bind: (...args) => {
          seen.push(sql);
          return { all: async () => ({ results: [] }) };
        },
      }),
    };
    const { counts, items } = await queryPendingReview(db, "2026-10-09T00:00:00.000Z");
    assert.deepEqual(counts, {});
    assert.deepEqual(items, []);
    assert.ok(seen.every((sql) => sql.includes("!= 'real_contact'")));
    const { text } = buildDailySummaryEmail({ day: "d", counts, items });
    assert.match(text, /Nada a revisar/);
  });
});
