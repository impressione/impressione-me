import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifyContact,
  CONFIDENCE_THRESHOLD,
  CONTACT_TYPES,
} from "../workers/app/contact-classifier.js";

function mockAI(answer) {
  return { run: async () => ({ answers: { tipo: answer } }) };
}

describe("contact classifier (clef-flash)", () => {
  it("high-confidence choice -> type with confidence + breakdown reason", async () => {
    const ai = mockAI({
      probabilities: { real_contact: 0.91, marketing: 0.06, spam: 0.03 },
    });
    const res = await classifyContact(ai, { message: "x" });
    assert.equal(res.type, "real_contact");
    assert.equal(res.confidence, 0.91);
    assert.match(res.reason, /real_contact 0\.91/);
  });

  it("below threshold -> unclassified (fail-closed)", async () => {
    const ai = mockAI({
      probabilities: { real_contact: 0.5, marketing: 0.4, spam: 0.1 },
    });
    const res = await classifyContact(ai, { message: "x" });
    assert.equal(res.type, "unclassified");
    assert.ok(res.confidence < CONFIDENCE_THRESHOLD);
  });

  it("AI throws -> unclassified with ai-error reason", async () => {
    const ai = { run: async () => { throw new Error("boom"); } };
    const res = await classifyContact(ai, { message: "x" });
    assert.equal(res.type, "unclassified");
    assert.match(res.reason, /ai-error/);
  });

  it("unparseable answer -> unclassified", async () => {
    const ai = mockAI({ nonsense: true });
    const res = await classifyContact(ai, { message: "x" });
    assert.equal(res.type, "unclassified");
  });

  it("phishing answer -> phishing_scam, no email path", async () => {
    const ai = mockAI({
      probabilities: { phishing_scam: 0.93, real_contact: 0.03, marketing: 0.02, spam: 0.01, suspicious_language: 0.01 },
    });
    const res = await classifyContact(ai, { message: "x" });
    assert.equal(res.type, "phishing_scam");
    assert.notEqual(res.type, "real_contact");
  });

  it("other-language answer -> suspicious_language", async () => {
    const ai = mockAI({
      probabilities: { suspicious_language: 0.88, real_contact: 0.07, marketing: 0.03, spam: 0.02, phishing_scam: 0.0 },
    });
    const res = await classifyContact(ai, { message: "x" });
    assert.equal(res.type, "suspicious_language");
  });

  it("spam wins but phishing close and above threshold -> escalates to phishing_scam", async () => {
    const ai = mockAI({
      probabilities: { spam: 0.7, phishing_scam: 0.62, real_contact: 0.0, marketing: 0.0, suspicious_language: 0.0 },
    });
    const res = await classifyContact(ai, { message: "x" });
    assert.equal(res.type, "phishing_scam");
    assert.equal(res.confidence, 0.62);
    assert.match(res.reason, /preempção/);
  });

  it("spam wins with phishing far -> stays spam", async () => {
    const ai = mockAI({
      probabilities: { spam: 0.8, phishing_scam: 0.1, real_contact: 0.05, marketing: 0.03, suspicious_language: 0.02 },
    });
    const res = await classifyContact(ai, { message: "x" });
    assert.equal(res.type, "spam");
  });

  function mockBilingual(tipoProbs, idiomaProbs) {
    return {
      run: async () => ({
        answers: { tipo: { probabilities: tipoProbs }, idioma: { probabilities: idiomaProbs } },
      }),
    };
  }

  it("real content in other language -> suspicious_language (caso igbo)", async () => {
    const ai = mockBilingual(
      { real_contact: 0.65, marketing: 0.03, phishing_scam: 0.05, spam: 0.07, suspicious_language: 0.19 },
      { other: 0.9, portuguese: 0.05, english: 0.05 },
    );
    const res = await classifyContact(ai, { message: "Ndewo, achọrọ m ịmara ọnụahịa gị." });
    assert.equal(res.type, "suspicious_language");
    assert.notEqual(res.type, "real_contact");
  });

  it("phishing in other language -> stays phishing_scam (mais específico)", async () => {
    const ai = mockBilingual(
      { phishing_scam: 0.85, spam: 0.1, real_contact: 0.02, marketing: 0.02, suspicious_language: 0.01 },
      { other: 0.95, portuguese: 0.02, english: 0.03 },
    );
    const res = await classifyContact(ai, { message: "x" });
    assert.equal(res.type, "phishing_scam");
  });

  it("real content in PT/EN -> stays real_contact", async () => {
    const ai = mockBilingual(
      { real_contact: 0.91, marketing: 0.06, spam: 0.03 },
      { portuguese: 0.97, english: 0.02, other: 0.01 },
    );
    const res = await classifyContact(ai, { message: "x" });
    assert.equal(res.type, "real_contact");
  });

  it("weak other-language signal -> keeps tipo (sem flip por ruído)", async () => {
    const ai = mockBilingual(
      { real_contact: 0.85, marketing: 0.1, spam: 0.05 },
      { other: 0.3, portuguese: 0.6, english: 0.1 },
    );
    const res = await classifyContact(ai, { message: "x" });
    assert.equal(res.type, "real_contact");
  });

  it("sends 2 calls: message-only state for tipo and idioma", async () => {
    const calls = [];
    const ai = {
      run: async (model, input) => {
        calls.push([model, input]);
        return { answers: { tipo: { probabilities: { spam: 0.99, real_contact: 0.01, phishing_scam: 0.0 } } } };
      },
    };
    const submission = { name: "N", company: "C", interest: "Arquitetura e reestruturação técnica", message: "M" };
    const res = await classifyContact(ai, submission);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], "@cf/cloudflare/clef-flash");
    assert.equal(calls[0][1].state, "M");
    assert.equal(calls[0][1].questions.tipo.type, "choice");
    assert.deepEqual(Object.keys(calls[0][1].questions.tipo.criteria).sort(), [...CONTACT_TYPES].sort());
    assert.equal(calls[1][1].state, "M");
    assert.deepEqual(Object.keys(calls[1][1].questions), ["idioma"]);
    assert.equal(res.type, "spam");
  });

  it("golden fixtures stay well-formed", async () => {
    const fixtures = JSON.parse(
      readFileSync(new URL("./fixtures/contacts.json", import.meta.url)),
    );
    assert.ok(fixtures.length >= 6);
    for (const item of fixtures) {
      assert.ok(typeof item.message === "string" && item.message.length > 0);
      assert.ok(
        ["real_contact", "spam", "phishing_scam", "suspicious_language"].includes(item.expected),
      );
    }
  });
});
