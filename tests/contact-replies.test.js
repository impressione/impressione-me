import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  markReplyFailed,
  markReplySent,
  saveReply,
} from "../workers/app/contact-replies.js";

function fakeDb(row = null) {
  const calls = [];
  return {
    calls,
    prepare: (sql) => ({
      bind: (...args) => {
        calls.push({ sql, args });
        return {
          run: async () => ({ meta: { changes: 1 } }),
          first: async () => row,
        };
      },
    }),
  };
}

const contact = { id: 10, email: "maria@example.com" };
const decision = {
  isReturning: true,
  previousContacts: 2,
  lastContactAt: "2026-10-01T10:00:00.000Z",
};

describe("contact replies store", () => {
  it("saves a pending reply with history context", async () => {
    const db = fakeDb({ id: 1, contact_id: 10, status: "pending" });
    const row = await saveReply(db, {
      contact,
      decision,
      draft: {
        ok: true,
        model: "@cf/meta/llama-4-scout-17b-16e-instruct",
        subject: "Re: contato",
        body: "Olá",
      },
      now: new Date("2026-10-10T12:00:00.000Z"),
    });

    assert.equal(row.status, "pending");
    const insert = db.calls[0];
    assert.match(insert.sql, /INSERT OR IGNORE INTO contact_replies/);
    assert.equal(insert.args[0], 10);
    assert.equal(insert.args[1], "maria@example.com");
    assert.equal(insert.args[2], "pending");
    assert.equal(insert.args[3], 1);
    assert.equal(insert.args[4], 2);
    assert.equal(insert.args[5], "2026-10-01T10:00:00.000Z");
    assert.equal(insert.args[6], "@cf/meta/llama-4-scout-17b-16e-instruct");
    assert.equal(insert.args[11], "2026-10-10T12:00:00.000Z");
  });

  it("saves a failed generation as failed with reason/error", async () => {
    const db = fakeDb({ id: 1, status: "failed" });
    await saveReply(db, {
      contact,
      decision: { ...decision, isReturning: false, previousContacts: 0, lastContactAt: null },
      draft: {
        ok: false,
        reason: "reply-generation-failed",
        error: "llama: 429 | qwen: 503",
      },
    });

    const args = db.calls[0].args;
    assert.equal(args[2], "failed");
    assert.equal(args[3], 0);
    assert.equal(args[9], "reply-generation-failed");
    assert.equal(args[10], "llama: 429 | qwen: 503");
  });

  it("marks sent and failed", async () => {
    const db = fakeDb();
    await markReplySent(db, 10, new Date("2026-10-10T12:05:00.000Z"));
    assert.match(db.calls[0].sql, /SET status = 'sent'/);
    assert.deepEqual(db.calls[0].args, ["2026-10-10T12:05:00.000Z", 10]);

    await markReplyFailed(db, 10, "resend 422");
    assert.match(db.calls[1].sql, /SET status = 'failed'/);
    assert.deepEqual(db.calls[1].args, ["resend 422", 10]);
  });
});
