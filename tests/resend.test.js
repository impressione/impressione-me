import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  RESEND_ENDPOINT,
  isResendConfigured,
  sendVisitorReply,
} from "../workers/app/resend.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return calls;
}

const env = {
  RESEND_API_KEY: "re_test",
  FROM_EMAIL: "contato@impressione.me",
  REPLY_FROM_EMAIL: "respostas@impressione.me",
  TEAM_EMAIL: "contato@impressione.me",
};

describe("resend", () => {
  it("posts the visitor reply with reply_to the team", async () => {
    const calls = mockFetch(
      async () => new Response(JSON.stringify({ id: "abc" }), { status: 200 }),
    );

    const result = await sendVisitorReply(env, {
      to: "maria@example.com",
      subject: "Re: contato",
      text: "texto",
      html: "<p>texto</p>",
      idempotencyKey: "contact-10",
    });

    assert.deepEqual(result, { id: "abc" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, RESEND_ENDPOINT);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.Authorization, "Bearer re_test");
    assert.equal(calls[0].init.headers["Idempotency-Key"], "contact-10");
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      from: "respostas@impressione.me",
      to: ["maria@example.com"],
      subject: "Re: contato",
      text: "texto",
      html: "<p>texto</p>",
      reply_to: "contato@impressione.me",
    });
  });

  it("falls back to FROM_EMAIL and omits idempotency header", async () => {
    const calls = mockFetch(async () => new Response("{}", { status: 200 }));
    const { REPLY_FROM_EMAIL, ...withoutReplyFrom } = env;
    await sendVisitorReply(withoutReplyFrom, {
      to: "a@b.com",
      subject: "s",
      text: "t",
      html: "h",
    });
    assert.equal(JSON.parse(calls[0].init.body).from, "contato@impressione.me");
    assert.equal(calls[0].init.headers["Idempotency-Key"], undefined);
  });

  it("throws on non-2xx with status and body", async () => {
    mockFetch(async () => new Response("domain not verified", { status: 422 }));
    await assert.rejects(
      () =>
        sendVisitorReply(env, {
          to: "a@b.com",
          subject: "s",
          text: "t",
          html: "h",
        }),
      /resend 422: domain not verified/,
    );
  });

  it("throws when the API key is missing", async () => {
    assert.equal(isResendConfigured({}), false);
    await assert.rejects(
      () =>
        sendVisitorReply({ FROM_EMAIL: "f" }, {
          to: "a@b.com",
          subject: "s",
          text: "t",
          html: "h",
        }),
      /RESEND_API_KEY/,
    );
  });
});
