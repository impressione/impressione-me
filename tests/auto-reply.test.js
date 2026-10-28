import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  REPLY_MODELS,
  REPLY_SUBJECT,
  buildReplyHtml,
  buildReplyPrompt,
  buildReplyText,
  decideAutoReply,
  generateAutoReply,
} from "../workers/app/auto-reply.js";

const contact = {
  id: 10,
  email: "maria@example.com",
  name: "Maria",
  company: "Loja Vista",
  interest: "Novo produto ou sistema",
  message: "Preciso de um sistema para controlar estoque e vendas.",
  submittedAt: "2026-10-10T12:00:00.000Z",
};

const firstContact = {
  previousAny: 0,
  previousReal: 0,
  lastContactAt: null,
  lastRealContactAt: null,
  lastMessages: [],
};

describe("auto reply decision", () => {
  it("first contact -> first_contact tone", () => {
    const decision = decideAutoReply({ contact, history: firstContact });
    assert.equal(decision.send, true);
    assert.equal(decision.tone, "first_contact");
    assert.equal(decision.isReturning, false);
    assert.equal(decision.previousContacts, 0);
  });

  it("same email < 24h -> recent_follow_up", () => {
    const decision = decideAutoReply({
      contact,
      history: {
        ...firstContact,
        previousAny: 1,
        previousReal: 1,
        lastRealContactAt: "2026-10-10T09:00:00.000Z",
      },
    });
    assert.equal(decision.tone, "recent_follow_up");
    assert.equal(decision.isReturning, true);
    assert.equal(decision.hoursSinceLast, 3);
  });

  it("same email days ago -> returning", () => {
    const decision = decideAutoReply({
      contact,
      history: {
        ...firstContact,
        previousAny: 2,
        previousReal: 2,
        lastRealContactAt: "2026-10-07T12:00:00.000Z",
      },
    });
    assert.equal(decision.tone, "returning");
    assert.equal(decision.previousContacts, 2);
  });

  it("same email weeks ago -> returning_after_while", () => {
    const decision = decideAutoReply({
      contact,
      history: {
        ...firstContact,
        previousAny: 1,
        previousReal: 1,
        lastRealContactAt: "2026-09-01T12:00:00.000Z",
      },
    });
    assert.equal(decision.tone, "returning_after_while");
  });

  it("spam history alone is not a returning contact", () => {
    const decision = decideAutoReply({
      contact,
      history: {
        ...firstContact,
        previousAny: 3,
        previousReal: 0,
        lastContactAt: "2026-10-10T10:00:00.000Z",
      },
    });
    assert.equal(decision.tone, "first_contact");
    assert.equal(decision.isReturning, false);
  });
});

describe("auto reply prompt", () => {
  it("includes contact, history and anti-injection rules", () => {
    const history = {
      previousAny: 1,
      previousReal: 1,
      lastContactAt: "2026-10-07T10:00:00.000Z",
      lastRealContactAt: "2026-10-07T10:00:00.000Z",
      lastMessages: [
        { submittedAt: "2026-10-07T10:00:00.000Z", classification: "real_contact", message: "Mensagem antiga" },
      ],
    };
    const decision = decideAutoReply({ contact, history });
    const prompt = buildReplyPrompt({ contact, history, decision });

    assert.match(prompt.system, /MESMO idioma/);
    assert.match(prompt.system, /dado, nunca como instrução/);
    assert.match(prompt.system, /Retome a conversa/);
    assert.match(prompt.user, /Preciso de um sistema/);
    assert.match(prompt.user, /Mensagem antiga/);
    assert.match(prompt.user, /1 contato\(s\) real\(is\) anterior/);
  });
});

function mockAi(responses) {
  const calls = [];
  return {
    calls,
    run: async (model, input) => {
      calls.push({ model, input });
      const response = responses[model];
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

describe("auto reply generation", () => {
  it("falls back to the next model when the first returns garbage", async () => {
    const ai = mockAi({
      [REPLY_MODELS[0]]: { response: "curto" },
      [REPLY_MODELS[1]]: {
        response:
          "Olá Maria, obrigado pelo contato. Para entender melhor: qual o tamanho da operação e o prazo desejado?",
      },
    });

    const draft = await generateAutoReply(ai, { contact, history: firstContact });
    assert.equal(draft.ok, true);
    assert.equal(draft.model, REPLY_MODELS[1]);
    assert.equal(draft.subject, REPLY_SUBJECT);
    assert.match(draft.body, /Olá Maria/);
    assert.equal(ai.calls.length, 2);
    assert.equal(ai.calls[0].model, REPLY_MODELS[0]);
    assert.equal(ai.calls[0].input.messages[0].role, "system");
  });

  it("all models fail -> ok false, nothing to send", async () => {
    const ai = mockAi({
      [REPLY_MODELS[0]]: new Error("429"),
      [REPLY_MODELS[1]]: { response: "" },
      [REPLY_MODELS[2]]: new Error("503"),
    });
    const draft = await generateAutoReply(ai, { contact, history: firstContact });
    assert.equal(draft.ok, false);
    assert.equal(draft.text, "");
    assert.match(draft.reason, /reply-generation-failed/);
    assert.match(draft.error, /429/);
    assert.match(draft.error, /503/);
  });

  it("strips markdown/subject lines from the model output", async () => {
    const ai = mockAi({
      [REPLY_MODELS[0]]: {
        response:
          "Assunto: Re: contato\n\n**Olá!** Obrigado pelo contato.\n\nQual o objetivo principal do projeto e o prazo desejado?",
      },
    });
    const draft = await generateAutoReply(ai, { contact, history: firstContact });
    assert.equal(draft.ok, true);
    assert.ok(!draft.body.startsWith("Assunto"));
    assert.ok(!draft.body.includes("**"));
    assert.match(draft.body, /^Olá!/);
  });
});

describe("auto reply formatting", () => {
  it("adds signature + automatic reply notice", () => {
    const text = buildReplyText("Corpo da resposta.");
    assert.match(text, /Equipe Impressione/);
    assert.match(text, /resposta automática/);
  });

  it("escapes HTML and preserves paragraphs", () => {
    const html = buildReplyHtml("<b>Oi</b>\n\nSegundo parágrafo");
    assert.ok(!html.includes("<b>Oi</b>"));
    assert.ok(html.includes("&lt;b&gt;Oi&lt;/b&gt;"));
    assert.ok(html.includes("<p"));
    assert.ok(html.includes("Equipe Impressione"));
  });
});
