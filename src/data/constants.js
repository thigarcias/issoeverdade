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

/** Rótulos dos desfechos do servidor, incluindo recusas de política. */
export const OUTCOME_LABEL = {
  checked: "Checagem executada",
  partial_coverage: "Cobertura parcial",
  insufficient_input: "Material insuficiente",
  inaccessible_media: "Mídia inacessível",
  no_verifiable_claims: "Sem afirmação verificável",
  content_refused: "Recusado por política de conteúdo",
  moderation_uncovered: "Vídeo sem cobertura de moderação",
  error: "Erro operacional",
  legacy: "Registro legado",
};

/** Códigos de erro do endpoint de checagem traduzidos para o usuário. */
export const ERROR_MESSAGES = {
  missing_api_key: "Serviço de checagem indisponível no momento.",
  upstream_timeout: "A checagem demorou demais. Tente de novo.",
  upstream_fetch_failed: "Não consegui falar com o serviço de IA. Tente de novo.",
  model_bad_json: "A IA respondeu num formato estranho. Tente de novo.",
  FreeTierError: "Serviço de IA indisponível. Tente de novo mais tarde.",
  rate_limited: "Muitas checagens em pouco tempo. Aguarde alguns minutos.",
  capacity_full: "Todas as checagens simultâneas estão ocupadas. Tente em instantes.",
  daily_budget: "O limite diário de checagens foi atingido. Tente novamente amanhã.",
  limits_unavailable: "Controles de uso não configurados nesta implantação; novas checagens estão suspensas.",
  private_url: "Esse endereço não é aceito: apenas páginas públicas em HTTP/HTTPS.",
  invalid_url: "URL inválida.",
  text_too_long: "O texto enviado passa do limite aceito. Envie um trecho menor.",
  upload_too_large: "O arquivo excede o limite de envio.",
  payload_too_large: "O envio excede o limite permitido.",
  moderation_unavailable: "Moderação de conteúdo indisponível; a checagem não foi executada.",
  moderation_uncovered: "O processamento de vídeo está desativado nesta implantação (cobertura de moderação não aprovada).",
  content_refused: "O material foi recusado pela política de conteúdo.",
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
