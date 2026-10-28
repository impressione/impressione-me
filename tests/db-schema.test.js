import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  ensureSchema,
  getSchemaSql,
  _resetSchemaForTests,
} from "../workers/app/db.js";

const normalize = (sql) => sql.replace(/\s+/g, " ").trim();

const migrationsDir = new URL("../workers/app/migrations/", import.meta.url);

function versionedSchema() {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(new URL(file, migrationsDir), "utf8"))
    .join("\n");
}

describe("db schema", () => {
  it("embedded DDL matches versioned migration files", () => {
    assert.equal(normalize(getSchemaSql()), normalize(versionedSchema()));
  });

  it("ensureSchema batches single statements once, retries after failure", async () => {
    _resetSchemaForTests();
    let batches = 0;
    const failing = {
      prepare: (sql) => ({ sql }),
      batch: async () => { batches++; throw new Error("d1 down"); },
    };
    await assert.rejects(() => ensureSchema(failing), /d1 down/);

    const prepared = [];
    const ok = {
      prepare: (sql) => {
        prepared.push(sql);
        return { sql };
      },
      batch: async (stmts) => { batches++; return stmts.map(() => ({})); },
    };
    await ensureSchema(ok);
    await ensureSchema(ok);
    assert.equal(batches, 2); // 1 falha + 1 sucesso (2ª chamada usa cache)
    assert.equal(prepared.length, 6);
    assert.ok(prepared.every((sql) => !sql.includes(";")));
    assert.ok(prepared[0].startsWith("CREATE TABLE IF NOT EXISTS contacts"));
    assert.ok(prepared.some((sql) => sql.includes("contact_replies")));
    assert.ok(prepared.some((sql) => sql.includes("idx_contacts_email")));
  });
});
