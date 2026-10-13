// Constantes de UI — selos, cores e textos do pipeline.
// Todo resultado de checagem vem da API real (/api/verify).

export const VERDICTS = {
  true: { label: "Verdadeiro", tint: "tint-up", color: "#2f6b44" },
  mostly_true: { label: "Maioria verdadeira", tint: "tint-up", color: "#2f6b44" },
  partially_true: { label: "Parcialmente verdadeiro", tint: "tint-warn", color: "#7a5b1e" },
  distorted: { label: "Distorcido", tint: "tint-down", color: "#c22a17" },
  unproven: { label: "Sem comprovação", tint: "tint-warn", color: "#7a5b1e" },
  misleading: { label: "Enganoso", tint: "tint-down", color: "#c22a17" },
  false: { label: "Falso", tint: "tint-down", color: "#c22a17" },
};

/**
 * Escala antiga: "mixed" (Misto, 55–74) foi dividido em "partially_true" (65–74)
 * e "distorted" (55–64). Migra registros antigos pelo score para exibição.
 */
export function migrateVerdict(verdict, score) {
  if (verdict === "mixed") return (Number(score) || 0) >= 65 ? "partially_true" : "distorted";
  if ((verdict == null || verdict === "") && score == null) return null;
  return VERDICTS[verdict] ? verdict : "unproven";
}

export const CLAIM_STATUS = {
  true: { label: "Verdade", tint: "tint-up", color: "#2f6b44" },
  false: { label: "Falso", tint: "tint-down", color: "#c22a17" },
  unproven: { label: "Sem comprovação", tint: "tint-warn", color: "#7a5b1e" },
  context: { label: "Precisa de contexto", tint: "tint-info", color: "#33608f" },
};

export const PIPELINE_STEPS = [
  {
    id: "intake",
    title: "Recebendo seu conteúdo",
    hint: "Preparamos link, texto, imagem ou vídeo para análise.",
  },
  {
    id: "transcribe",
    title: "Analisando conteúdo disponível",
    hint: "Áudio pode ser transcrito e quadros podem ser amostrados; a cobertura pode ser parcial.",
  },
  {
    id: "claims",
    title: "Separando cada afirmação",
    hint: "Identificamos afirmações verificáveis e registramos limites da análise.",
  },
  {
    id: "sources",
    title: "Buscando evidências",
    hint: "Vinculamos trechos e fontes às afirmações quando há material disponível.",
  },
  {
    id: "score",
    title: "Consolidando o resultado",
    hint: "A nota não é probabilidade calibrada; pode não haver veredito.",
  },
];

// Frases rotativas do "thinking" — exibidas enquanto a IA trabalha.
// Estilo das empresas de IA: curtas, progressivas, ganham tempo de leitura.
export const THINKING_LINES = [
  "Lendo o conteúdo…",
  "Entendendo o contexto…",
  "Separando as afirmações…",
  "Buscando evidências…",
  "Comparando com as evidências…",
  "Comparando versões…",
  "Pesando as evidências…",
  "Montando o veredito…",
];
