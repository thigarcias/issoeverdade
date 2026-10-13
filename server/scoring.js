// Sistema de pontuação determinística — mesma entrada, mesmo score.
// A IA segue a RUBRICA (pesos + âncoras + fórmula); o servidor VALIDA e
// recalcula. Divergência > 2 pontos = resposta da IA é corrigida.

export const SCORE_RUBRIC = `PONTUAÇÃO (siga exatamente, sem arredondar por "sensação"):

1) SEGMENTAÇÃO — 1 claim por unidade factual (frase com verbo factual, número,
data, nome ou evento). Não junte fatos distintos num claim só; não quebre a
mesma afirmação em dois. Cite o texto LITERAL entre aspas.

2) STATUS — use exatamente um:
- "true": fato confirmado por fonte oficial ou 2+ veículos independentes.
- "context": fato base real, mas apresentado de forma que induz a erro
  (omissão, recorte, exagero). Sempre explique o que falta na nota.
- "unproven": não há evidência pública suficiente para confirmar nem negar.
- "false": contradito por fonte oficial ou evidência direta.

3) SCORE DO CLAIM (âncoras fixas — escolha o valor exato da faixa):
- true + fonte oficial: 95 | true + 2 veículos: 90 | true + 1 veículo: 85
- context leve (falta nuance): 70 | context grave (induz a erro): 55
- unproven com indícios: 45 | unproven sem nada: 35
- false parcial: 20 | false total: 5

4) SCORE GERAL = média aritmética simples dos scores dos claims, arredondada.
Com 1 claim só, o score geral É o score do claim. Nunca invente outro número.

5) VEREDITO pela tabela (score geral → veredito):
- 90-100: "true" | 75-89: "mostly_true" | 55-74: "mixed"
- 35-54: "unproven" | 15-34: "misleading" | 0-14: "false"
Exceção: qualquer claim "false" total (5) limita o veredito a no máximo "mixed".`;

const BASE_RULES = `Regras: seja cético com prints sem origem e correntes de WhatsApp; USE A BUSCA NA WEB para verificar cada afirmação com dados atuais (não confie só na memória) — busque nomes, datas, números e eventos citados; cite no mínimo 3 fontes VARIADAS por checagem vindas dos resultados da busca, nunca repetindo o mesmo outlet — alterne entre: fontes oficiais (TSE, Câmara, Senado, Planalto, STF, IBGE, Banco Central), agências de checagem (Lupa, Aos Fatos, Estadão Verifica, UOL Confere, AFP Checamos), veículos grandes (G1, Folha, Estadão, O Globo, UOL, Poder360, Metrópoles, CNN Brasil) e regionais quando relevante; cada URL deve ser REAL, copiada dos resultados da busca (nunca invente). Tudo em pt-BR.`;

export const RESULT_SHAPE = `{"verdict":"true|mostly_true|mixed|unproven|misleading|false","score":0-100,"summary":"resumo em pt-BR, 1-2 frases","claims":[{"status":"true|false|unproven|context","score":0-100,"text":"a afirmação entre aspas","note":"justificativa curta em pt-BR"}],"sources":[{"outlet":"nome da fonte","detail":"tipo · data","url":"https://..."}]}`;

// Passo 1: julga com o que tem; se faltar conteúdo, pede mídia em vez de chutar.
export const SYSTEM_PROMPT_JUDGE = `Você é o verificador de fatos do "isso é verdade?", especializado na política do Brasil, segundo turno das Eleições 2026. Responda ESTRITAMENTE em JSON válido, sem markdown, sem texto fora do JSON.
Se o conteúdo abaixo for suficiente para checar, responda neste formato exato:
${RESULT_SHAPE}
Se NÃO for suficiente (ex.: link de vídeo sem transcrição, post sem texto, imagem sem descrição), responda APENAS:
{"needs_media":true,"reason":"motivo curto em pt-BR"}
${BASE_RULES}
${SCORE_RUBRIC}`;

// Passo 2: rejulga com transcrição/mídia extraída — aqui o veredito é final.
export const SYSTEM_PROMPT_FINAL = `Você é o verificador de fatos do "isso é verdade?", especializado na política do Brasil, segundo turno das Eleições 2026. Responda ESTRITAMENTE em JSON válido, sem markdown, sem texto fora do JSON, com este formato exato:
${RESULT_SHAPE}
${BASE_RULES}
${SCORE_RUBRIC}
Quando houver transcrição com timestamps, cheque frase por frase da transcrição.`;

// --- Validação server-side: recalcula e corrige divergências ---

const VERDICT_TABLE = [
  [90, "true"],
  [75, "mostly_true"],
  [55, "mixed"],
  [35, "unproven"],
  [15, "misleading"],
  [0, "false"],
];

export function verdictForScore(score) {
  for (const [min, v] of VERDICT_TABLE) {
    if (score >= min) return v;
  }
  return "false";
}

function clampScore(n, dflt) {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : dflt;
}

/**
 * Valida e corrige o JSON do modelo:
 * - scores de claims fora de 0-100 são clamped;
 * - score geral é recalculado = média dos claims (se houver claims);
 * - veredito é corrigido pela tabela (+ teto "mixed" se houver false total).
 * @returns {{ fixed: object, corrections: string[] }}
 */
export function validateResult(raw) {
  const corrections = [];
  const fixed = { ...raw };
  const statuses = ["true", "false", "unproven", "context"];
  fixed.claims = Array.isArray(raw?.claims)
    ? raw.claims.slice(0, 10).map((c, i) => {
        const status = statuses.includes(c?.status) ? c.status : "unproven";
        if (status !== c?.status) corrections.push(`claim${i + 1}: status inválido → unproven`);
        const score = clampScore(c?.score, 50);
        if (score !== Math.round(Number(c?.score))) corrections.push(`claim${i + 1}: score clamped → ${score}`);
        return { ...c, status, score };
      })
    : [];
  if (fixed.claims.length > 0) {
    const mean = Math.round(
      fixed.claims.reduce((a, c) => a + c.score, 0) / fixed.claims.length,
    );
    const claimed = clampScore(raw?.score, mean);
    const tol = fixed.claims.length === 1 ? 0 : 2;
    if (Math.abs(claimed - mean) > tol) {
      corrections.push(`score geral ${claimed} → ${mean} (média dos claims)`);
    }
    fixed.score = Math.abs(claimed - mean) > tol ? mean : claimed;
    let verdict = verdictForScore(fixed.score);
    if (fixed.claims.some((c) => c.status === "false" && c.score <= 10)) {
      const order = ["false", "misleading", "unproven", "mixed", "mostly_true", "true"];
      if (order.indexOf(verdict) > order.indexOf("mixed")) {
        corrections.push(`veredito ${verdict} → mixed (teto: há false total)`);
        verdict = "mixed";
      }
    }
    if (verdict !== raw?.verdict) {
      if (!corrections.some((c) => c.startsWith("veredito"))) {
        corrections.push(`veredito ${raw?.verdict} → ${verdict} (tabela)`);
      }
      fixed.verdict = verdict;
    } else {
      fixed.verdict = verdict;
    }
  } else {
    fixed.score = clampScore(raw?.score, 30);
    fixed.verdict = verdictForScore(fixed.score);
    if (fixed.verdict !== raw?.verdict) {
      corrections.push(`veredito sem claims ${raw?.verdict} → ${fixed.verdict} (tabela)`);
    }
  }
  return { fixed, corrections };
}
