import { buildReviewGroups, evidenceConfig, EVIDENCE_REVIEW_INSTRUCTIONS } from "./evidence.js";

const JEV_URL = "https://opencode.ai/inference/v1/systemone";
const VERDICTS = ["supports", "refutes", "context", "unclear"];
const INSTRUCTIONS = `${EVIDENCE_REVIEW_INSTRUCTIONS} Avalie o rumor identificável tal como alegado, sem convertê-lo em anúncio recente ou previsão a provar. Um desmentido explícito documentado por agência de checagem pode refutar o rumor exato quando sujeito, ação, objeto, alcance e condições coincidirem; não exija prova de que uma ação jamais ocorrerá. A data de publicação, isoladamente, não invalida um desmentido do mesmo rumor sem nova ocorrência especificada; distinga publicação e período de referência do fato. Nova medida, declaração, data ou evento na alegação exige evidência correspondente, não apenas desmentido de ocorrência anterior. Um rótulo "fake news" ou texto sobre o mesmo tema não substitui trecho e fundamentação pertinentes. As probabilidades classificam a relação documental do grupo, não são probabilidades de a alegação ser verdadeira.`;
const CRITERIA = {
  supports: "Os trechos do grupo, considerados em conjunto, sustentam a alegação inteira e exata. Comparações qualitativas de posições exigem documentação dos dois lados, mesmo objeto, alcance, condições e contexto temporal pertinente, sem cálculo obrigatório. Quando comparison estiver presente, o cálculo numérico deve ser eligible e relation supports, com operandos e escopos documentados. Um limite inferior não prova previsão ou total completo. Grupo incomplete nunca sustenta a alegação integral.",
  refutes: "Os trechos apresentam evidência explícita incompatível com a alegação inteira e exata no mesmo escopo, incluindo desmentido direto e fundamentado do mesmo rumor documentado por agência de checagem. Publicação antiga não impede refutação por si só, mas desmentido de outra ocorrência não resolve automaticamente nova medida, declaração, data ou evento especificados. Posições qualitativas devem ser comparadas no mesmo objeto, alcance e condições, sem exigir cálculo. Somente quando comparison estiver presente, exige-se cálculo eligible e relation refutes. Ausência de dados nunca refuta, nem grupo incomplete.",
  context: "O conjunto fornece contexto pertinente, mas não sustenta nem refuta a alegação integral, incluindo dados parciais, estimativas ou períodos/universos distintos.",
  unclear: "Dados insuficientes, não localizados, ambíguos, grupos incompletos ou escopos incompatíveis impedem concluir. Nunca transfira provas entre claims.",
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
  if (top.value < 0.8 || top.value - second.value < 0.2 - Number.EPSILON * 4) return "unclear";
  return top.verdict;
}

function tokens(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Revisão de relação textual por JEV; não estima a probabilidade de verdade. */
export async function reviewWithJev({ claims = [], citations = [], config = evidenceConfig(), fetchImpl = fetch } = {}) {
  const model = config.reviewModel || process.env.IEV_EVIDENCE_REVIEW_MODEL || "jev-1.13-free";
  const groups = buildReviewGroups({ claims, citations, config });
  const empty = { result: { claims: [] }, model, provider: "opencode", usage: { input: 0, output: 0, total: 0 } };
  if (groups.length === 0) return empty;
  const key = process.env.OPENCODE_API;
  if (!key) throw Object.assign(new Error("Revisão JEV indisponível: chave não configurada."), { code: "jev_review_failed" });
  const questions = Object.fromEntries(groups.map(({ claimIndex }) => [String(claimIndex), { type: "choice", instructions: `${INSTRUCTIONS} Avalie somente o grupo claimIndex ${claimIndex} do estado.`, criteria: CRITERIA }]));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.reviewTimeoutMs ?? config.timeoutMs ?? 20_000);
  try {
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
    const reviewed = groups.map(({ claimIndex, claim, incomplete }) => {
      const classified = !incomplete && typeof claim === "string" && claim.trim() ? classify(data?.answers?.[String(claimIndex)]) : null;
      const verdict = classified ?? "unclear";
      const note = classified === null
        ? "O grupo não recebeu uma classificação válida e completa; não há confirmação nem refutação."
        : NOTES[verdict];
      return { claimIndex, verdict, note };
    });
    const inputTokens = tokens(data?.usage?.input_tokens);
    const outputTokens = tokens(data?.usage?.output_tokens);
    return { result: { claims: reviewed }, model, provider: "opencode", usage: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens } };
  } catch {
    // Não propaga corpo, chave, erro de transporte ou mensagem fornecida pelo serviço.
    throw Object.assign(new Error("Não foi possível concluir a revisão JEV."), { code: "jev_review_failed" });
  } finally {
    clearTimeout(timer);
  }
}
