import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../workers/app/index.js";
import { _resetSchemaForTests } from "../workers/app/db.js";

beforeEach(() => _resetSchemaForTests());

function fakeEnv({ counts = [], items = [], replied = [] } = {}) {
  const sent = [];
  const runs = [];
  const db = {
    batch: async () => [],
    prepare(sql) {
      return {
        sql,
        bind(...args) {
          return {
            all: async () => ({
              results: sql.includes("GROUP BY")
                ? counts
                : sql.includes("contact_replies")
                  ? replied
                  : items,
            }),
            run: async () => {
              runs.push({ sql, args });
              return { meta: { changes: 1 } };
            },
            first: async () => null,
          };
        },
      };
    },
  };
  return {
    env: {
      DB: db,
      EMAIL: { send: async (message) => sent.push(message) },
      FROM_EMAIL: "contato@impressione.me",
      TEAM_EMAIL: "contato@impressione.me",
    },
    sent,
    runs,
  };
}

describe("scheduled daily summary", () => {
  it("nothing to review -> no email, no day guard", async () => {
    const { env, sent, runs } = fakeEnv();
    await worker.scheduled({}, env);
    assert.equal(sent.length, 0);
    assert.ok(!runs.some((call) => call.sql.includes("INSERT OR IGNORE INTO daily_summary")));
  });

  it("only auto-replied real contacts -> sends the report", async () => {
    const { env, sent, runs } = fakeEnv({
      counts: [{ type: "real_contact", n: 1 }],
      replied: [
        {
          submittedAt: "2026-10-10T10:00:00.000Z",
          email: "maria@example.com",
          name: "Maria",
          message: "Preciso de um sistema",
          reply_status: "sent",
          reply_model: "@cf/meta/llama-4-scout-17b-16e-instruct",
          reply_body: "Oi Maria, obrigado pelo contato.",
          is_returning: 0,
        },
      ],
    });

    await worker.scheduled({}, env);

    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /1 real/);
    assert.match(sent[0].text, /maria@example\.com/);
    assert.match(sent[0].text, /Oi Maria, obrigado pelo contato\./);
    assert.ok(runs.some((call) => call.sql.includes("INSERT OR IGNORE INTO daily_summary")));
    assert.ok(runs.some((call) => call.sql.includes("UPDATE daily_summary")));
  });

  it("review items only -> sends the report", async () => {
    const { env, sent } = fakeEnv({
      counts: [{ type: "spam", n: 2 }],
      items: [
        {
          submittedAt: "t",
          email: "bot@example.com",
          name: "",
          classification: "spam",
          confidence: 0.9,
          reason: "",
          excerpt: "seo barato",
        },
      ],
    });
    await worker.scheduled({}, env);
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /2 spam/);
  });
});
