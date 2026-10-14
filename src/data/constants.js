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
  empty_input: "Cole um link para checar.",
  invalid_url: "URL inválida.",
  text_too_long: "O texto enviado passa do limite aceito. Envie um trecho menor.",
  upload_too_large: "O arquivo excede o limite de envio.",
  payload_too_large: "O envio excede o limite permitido.",
  moderation_unavailable: "Moderação de conteúdo indisponível; a checagem não foi executada.",
  moderation_uncovered: "O processamento de vídeo está desativado nesta implantação (cobertura de moderação não aprovada).",
  content_refused: "O material foi recusado pela política de conteúdo.",
};

/** Texto público das atividades reais emitidas pelo servidor (sem % inventada). */
export const ACTIVITY_TEXT = {
  "source-classification": { title: "Identificando o conteúdo do link…", hint: "Tipo ainda não determinado." },
  "media-probe": { title: "Lendo a página vinculada…", hint: "Texto público e anexos ainda não confirmados." },
  "media-acquisition": { title: "Baixando a mídia…", hint: "Aquisição em execução; sem porcentagem inventada." },
  "media-upload": { title: "Processando o arquivo enviado…", hint: "Arquivo local; nunca apresentado como download." },
  "media-metadata": { title: "Lendo os metadados disponíveis…", hint: "Título, descrição e contexto da origem." },
  "media-transcription": { title: "Transcrevendo o áudio…", hint: "Áudio adquirido; a chamada real pode aguardar vaga." },
  "media-vision": { title: "Analisando os quadros disponíveis…", hint: "Amostragem parcial; pode não cobrir tudo." },
  judge: { title: "Investigando as afirmações e pesquisando fontes…", hint: "Julgamento com pesquisa habilitada." },
  "article-research": { title: "Pesquisando a publicação e suas alegações…", hint: "URL, título, site e alegações disponíveis." },
  final: { title: "Consolidando o resultado e seus limites…", hint: "Revisão das afirmações e evidências." },
  evidence: { title: "Consultando os documentos das fontes…", hint: "URLs do dossiê sendo obtidas." },
  "evidence-review": { title: "Conferindo se os trechos sustentam as afirmações…", hint: "Revisão da fidelidade das citações." },
  cache: { title: "Resultado recuperado do cache", hint: "Trabalho já feito; sem animação falsa." },
};

export const ACTIVITY_STATE_LABEL = {
  pending: "pendente",
  running: "em andamento",
  done: "concluída",
  skipped: "não aplicável",
  limited: "limitada",
  failed: "falhou",
};

/** Resumo público da modalidade identificada pelo servidor. */
export function modalitySummary(content, { hasUpload = false } = {}) {
  if (!content) return "Identificando o conteúdo do link…";
  if (content.modality === "cached") return "Resultado recuperado do cache · trabalho já feito";
  if (hasUpload && content.modality !== "image") return "Arquivo enviado · processando o conteúdo local";
  switch (content.modality) {
    case "text": return "Texto identificado · lendo o conteúdo disponível";
    case "article": return content.provisional ? "Notícia/documento provável · confirmando a leitura" : "Texto identificado · lendo o conteúdo disponível";
    case "social-post": return "Post identificado · verificando os anexos disponíveis";
    case "video": return "Vídeo identificado · preparando áudio e quadros";
    case "audio": return "Áudio identificado · preparando a transcrição";
    case "image": return hasUpload ? "Imagem enviada · lendo o texto visível" : "Imagem identificada · lendo o texto visível";
    case "document": return "Documento identificado · lendo o texto disponível";
    default: return "Identificando o conteúdo do link…";
  }
}
