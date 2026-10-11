// Classificação de contatos via clef-flash (modelo de decisão da Cloudflare).
// Fail-closed: qualquer erro ou baixa confiança resulta em "unclassified"
// (sem e-mail imediato, aparece no resumo diário).

export const CLASSIFIER_MODEL = "@cf/cloudflare/clef-flash";
export const CLASSIFIER_MODEL_ID = "clef-flash";
export const CONFIDENCE_THRESHOLD = 0.6;

export const CONTACT_TYPES = [
  "real_contact",
  "phishing_scam",
  "spam",
  "suspicious_language",
];

// `spam` tem prioridade menor que `phishing_scam`: vencendo por pouco,
// com phishing próximo, escala para phishing (golpe é o erro mais caro).
export const PHISHING_ESCALATION_MARGIN = 0.15;

export const LANGUAGE_TYPES = ["portuguese", "english", "other"];

// Idioma "other" com esta confiança mínima já torna o contato suspeito,
// mesmo que o conteúdo pareça legítimo (o single-choice diluía esse sinal).
export const FOREIGN_LANGUAGE_THRESHOLD = 0.5;

function breakdown(probs) {
  return CONTACT_TYPES.map((t) => `${t} ${Number(probs[t] ?? 0).toFixed(2)}`).join(" / ");
}

// Normaliza a resposta `choice` do clef para { option, probability }.
// Formatos tolerados (o schema exato varia por versão do modelo).
function bestOption(answer, types = CONTACT_TYPES) {
  if (!answer || typeof answer !== "object") return null;

  if (answer.probabilities && typeof answer.probabilities === "object") {
    let best = null;
    for (const type of types) {
      const prob = Number(answer.probabilities[type] ?? NaN);
      if (Number.isFinite(prob) && (!best || prob > best.probability)) {
        best = { option: type, probability: prob };
      }
    }
    return best;
  }

  if (typeof answer.answer === "string" && types.includes(answer.answer)) {
    const prob = Number(answer.confidence ?? answer.probability ?? NaN);
    return { option: answer.answer, probability: prob };
  }

  if (typeof answer.choice === "string" && types.includes(answer.choice)) {
    const prob = Number(answer.confidence ?? answer.probability ?? NaN);
    return { option: answer.choice, probability: prob };
  }

  return null;
}

export async function classifyContact(ai, submission) {
  try {
    // Chamada única: avalia SÓ `message`, passada direto como string.
    // name/company e `interest` (select sempre em PT) viciavam tipo e idioma.
    const message = typeof submission?.message === "string" ? submission.message : "";
    const response = await ai.run(CLASSIFIER_MODEL, {
      model: CLASSIFIER_MODEL_ID,
      state: message,
      questions: {
        tipo: {
          type: "choice",
          instructions: "Classifique o CONTEÚDO da mensagem do formulário de contato de uma consultoria de software.",
          criteria: {
            real_contact: "Pedido legítimo de projeto, orçamento ou conversa sobre software",
            phishing_scam: "Tentativa de golpe: urgência falsa, conta bloqueada, prêmio, pedido de dados/senha/pagamento, links suspeitos. Em dúvida entre spam e phishing, prefira phishing_scam",
            spam: "Lixo genérico sem tentativa clara de golpe: ofertas em massa (SEO, tráfego, listas, parcerias), testes, gibberish, link dumps. Prioridade menor que phishing_scam",
            suspicious_language: "Apenas se nada acima se aplicar e o texto claramente não for português nem inglês",
          },
        },
        idioma: {
          type: "choice",
          instructions: "Identifique o idioma do texto.",
          criteria: {
            portuguese: "Texto em português",
            english: "Texto em inglês",
            other: "Texto em qualquer outro idioma",
          },
        },
      },
    });

    const best = bestOption(response?.answers?.tipo);
    if (!best || !Number.isFinite(best.probability)) {
      return { type: "unclassified", confidence: 0, reason: "clef-answer-unparseable" };
    }
    const probs = response?.answers?.tipo?.probabilities ?? {};
    const langBest = bestOption(response?.answers?.idioma, LANGUAGE_TYPES);
    const langProbs = response?.answers?.idioma?.probabilities ?? {};
    // O clef não justifica em texto — o "motivo" é o placar completo.
    let { option, probability } = best;
    let reason = `tipo: ${breakdown(probs)} | idioma: ${LANGUAGE_TYPES.map((t) => `${t} ${Number(langProbs[t] ?? 0).toFixed(2)}`).join(" / ")}`;
    const phishingProb = Number(probs.phishing_scam ?? NaN);
    if (
      option === "spam" &&
      Number.isFinite(phishingProb) &&
      phishingProb >= probability - PHISHING_ESCALATION_MARGIN
    ) {
      option = "phishing_scam";
      probability = phishingProb;
      reason += " (preempção: phishing > spam)";
    }
    // Conteúdo legítimo em outro idioma continua suspeito: o site opera
    // em PT/EN. Só phishing mantém o rótulo (mais específico e acionável).
    if (
      option === "real_contact" &&
      langBest?.option === "other" &&
      langBest.probability >= FOREIGN_LANGUAGE_THRESHOLD
    ) {
      option = "suspicious_language";
      probability = langBest.probability;
      reason += " (preempção: idioma não-PT/EN)";
    }
    if (probability < CONFIDENCE_THRESHOLD) {
      return { type: "unclassified", confidence: probability, reason: `low-confidence: ${reason}` };
    }
    return { type: option, confidence: probability, reason };
  } catch (err) {
    return {
      type: "unclassified",
      confidence: 0,
      reason: `ai-error: ${err?.message || String(err)}`,
    };
  }
}
