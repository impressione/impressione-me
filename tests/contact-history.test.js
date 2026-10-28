import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loadContactHistory,
  normalizeEmail,
} from "../workers/app/contact-history.js";

function fakeDb({ summary = null, recent = [] } = {}) {
  const calls = [];
  return {
    calls,
    prepare: (sql) => ({
      bind: (...args) => {
        calls.push({ sql, args });
        return {
          first: async () => summary,
          all: async () => ({ results: recent }),
        };
      },
    }),
  };
}

describe("contact history", () => {
  it("normalizes email (trim + lowercase)", () => {
    assert.equal(normalizeEmail("  Ada@Example.COM "), "ada@example.com");
    assert.equal(normalizeEmail(null), "");
  });

  it("groups by lowercased email and only looks at previous ids", async () => {
    const db = fakeDb({
      summary: {
        previous_any: 3,
        previous_real: 2,
        last_contact_at: "2026-10-10T12:00:00.000Z",
        last_real_contact_at: "2026-10-09T12:00:00.000Z",
      },
      recent: [
        { submittedAt: "2026-10-10T12:00:00.000Z", classification: "spam", message: "x" },
        { submittedAt: "2026-10-09T12:00:00.000Z", classification: "real_contact", message: "y" },
      ],
    });

    const history = await loadContactHistory(db, {
      id: 42,
      email: " Ada@Example.COM ",
      submittedAt: "2026-10-10T13:00:00.000Z",
    });

    assert.equal(history.email, "ada@example.com");
    assert.equal(history.previousAny, 3);
    assert.equal(history.previousReal, 2);
    assert.equal(history.lastContactAt, "2026-10-10T12:00:00.000Z");
    assert.equal(history.lastRealContactAt, "2026-10-09T12:00:00.000Z");
    assert.equal(history.lastMessages.length, 2);

    assert.equal(db.calls.length, 2);
    for (const call of db.calls) {
      assert.match(call.sql, /LOWER\(email\) = \?/);
      assert.match(call.sql, /id < \?/);
      assert.deepEqual(call.args, ["ada@example.com", 42]);
    }
  });

  it("empty history when there is no email/id", async () => {
    const db = fakeDb();
    const history = await loadContactHistory(db, { email: "", id: 1 });
    assert.equal(history.previousAny, 0);
    assert.equal(history.previousReal, 0);
    assert.deepEqual(history.lastMessages, []);
    assert.equal(db.calls.length, 0);
  });

  it("null aggregates -> zero (D1 returns nulls for empty sets)", async () => {
    const db = fakeDb({
      summary: {
        previous_any: 0,
        previous_real: null,
        last_contact_at: null,
        last_real_contact_at: null,
      },
    });
    const history = await loadContactHistory(db, { id: 2, email: "a@b.com" });
    assert.equal(history.previousAny, 0);
    assert.equal(history.previousReal, 0);
    assert.equal(history.lastRealContactAt, null);
  });
});
