import { buildReviewBatches, evidenceConfig, EVIDENCE_REVIEW_INSTRUCTIONS } from "./evidence.js";

const JEV_URL = "https://opencode.ai/inference/v1/systemone";
const VERDICTS = ["supports", "refutes", "context", "unclear"];
const CRITERIA = {
  supports: "O conjunto implica todos os componentes efetivamente afirmados, preservando atribuição, modalidade, negativa e escopo. Detalhes adicionais compatíveis não exigem identidade integral entre fonte e resumo. Quando comparison existir, exige cálculo eligible e relation supports.",
  refutes: "O conjunto documenta negação ou incompatibilidade explícita com a alegação no mesmo escopo, não apenas ausência de suporte. Quando comparison existir, exige cálculo eligible e relation refutes.",
  context: "O conjunto não implica nem contradiz a alegação: falta um componente realmente afirmado ou há outro alcance, modalidade ou período. Não crie lacuna apenas porque a fonte contém mais detalhes compatíveis.",
  unclear: "Ambiguidade real ou grupo incomplete impede determinar a relação documental. Simples ausência de suporte é context, não uma segunda categoria concorrente. Nunca transfira provas entre claims.",
};
const NOTES = {
  supports: "O conjunto dos trechos documenta a alegação no escopo e período informados.",
  refutes: "O conjunto dos trechos documenta fatos incompatíveis com a alegação no mesmo escopo e período.",
  context: "O conjunto dos trechos fornece contexto, mas não comprova nem refuta integralmente a alegação.",
  unclear: "O conjunto documental permanece inconclusivo; não há confirmação nem refutação.",
};

function classify(answer) {
  if (answer?.type !== "choice" || !VERDICTS.includes(answer.choice)) return null;
  const probabilities = VERDICTS.map((verdict) => ({ verdict, value: answer.probabilities?.[verdict] }));
  if (probabilities.some(({ value }) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) return null;
  probabilities.sort((a, b) => b.value - a.value);
  const [top, second] = probabilities;
  if (top.verdict !== answer.choice) return null;
  // Tolerância apenas para o arredondamento binário na fronteira exata de 0,2.
  if (top.value < 0.7 || top.value - second.value < 0.2 - Number.EPSILON * 4) return "unclear";
  return top.verdict;
}

function tokens(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Revisão de relação textual por JEV; não estima a probabilidade de verdade. */
export async function reviewWithJev({ claims = [], citations = [], config = evidenceConfig(), fetchImpl = fetch } = {}) {
  const model = config.reviewModel || process.env.IEV_EVIDENCE_REVIEW_MODEL || "jev-1.13-free";
  const batches = buildReviewBatches({ claims, citations, config });
  const empty = { result: { claims: [] }, model, provider: "opencode", usage: { input: 0, output: 0, total: 0 } };
  if (batches.length === 0) return empty;
  const key = process.env.OPENCODE_API;
  if (!key) throw Object.assign(new Error("Revisão JEV indisponível: chave não configurada."), { code: "jev_review_failed" });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.reviewTimeoutMs ?? config.timeoutMs ?? 20_000);
  try {
    const reviewed = [];
    let inputTokens = 0;
    let outputTokens = 0;
    for (const groups of batches) {
      if (controller.signal.aborted) throw new Error("timeout");
      const questions = Object.fromEntries(groups.map(({ claimIndex }) => [String(claimIndex), {
        type: "choice",
        instructions: `${EVIDENCE_REVIEW_INSTRUCTIONS} Avalie somente o grupo claimIndex ${claimIndex} do estado. As probabilidades classificam a relação documental, não a verdade do fato.`,
        criteria: CRITERIA,
      }]));
      const response = await fetchImpl(JEV_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, state: JSON.stringify({ claims: groups }), questions }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("http_error");
      let data;
      try {
        data = await response.json();
      } catch (error) {
        if (controller.signal.aborted) throw error;
        data = null;
      }
      for (const { claimIndex, claim, incomplete } of groups) {
        const classified = !incomplete && typeof claim === "string" && claim.trim() ? classify(data?.answers?.[String(claimIndex)]) : null;
        const verdict = classified ?? "unclear";
        const note = classified === null
          ? "O grupo não recebeu uma classificação válida e completa; não há confirmação nem refutação."
          : NOTES[verdict];
        reviewed.push({ claimIndex, verdict, note });
      }
      inputTokens += tokens(data?.usage?.input_tokens);
      outputTokens += tokens(data?.usage?.output_tokens);
    }
    return { result: { claims: reviewed }, model, provider: "opencode", usage: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens } };
  } catch {
    // Não propaga corpo, chave, erro de transporte ou mensagem fornecida pelo serviço.
    throw Object.assign(new Error("Não foi possível concluir a revisão JEV."), { code: "jev_review_failed" });
  } finally {
    clearTimeout(timer);
  }
}
