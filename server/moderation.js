// Triagem de propósito e moderação de conteúdo sensível.
// Regra de produto: checar afirmações públicas sobre temas difíceis é permitido;
// recusar só o que não pode ser processado/redistribuído (abuso sexual infantil,
// conteúdo sexual explícito) e pedidos diretos ao assistente. O resto é marcado
// como sensível e registrado, nunca usado como motivo de recusa por si só.
// Falha da moderação em produção = recusa (fail-closed), nunca liberação.
import { createHash } from "node:crypto";
import { clip } from "./text.js";
import { mediaLimits } from "./media.js";
import { uploadLimits } from "./uploads.js";
import { evidenceConfig } from "./evidence.js";

const OPENAI_MODERATION_URL = "https://api.openai.com/v1/moderations";
const HARD_CATEGORIES = ["sexual/minors", "sexual"];
const DEFAULT_THRESHOLDS = { "sexual/minors": 0.1, sexual: 0.7 };
// Orçamento conservador de caracteres por chamada ao provedor de moderação.
// Conteúdo maior é dividido em partes com sobreposição explícita: nada é
// descartado silenciosamente e a cobertura real é reportada. Acima do orçamento
// total de processamento a moderação retorna erro explícito em vez de analisar
// como se o conteúdo fosse integral. Não é filtro por assunto: temas sensíveis
// de reportagem continuam permitidos; só categorias configuradas recusam.
const MAX_MODERATION_CHARS = 24_000;
const MAX_MODERATION_CHUNKS = 8;
const MODERATION_OVERLAP_CHARS = 200;

/** Divide o texto em partes, tentando cortar em espaços ou quebras de linha. */
function splitModerationText(value, limit, overlap) {
  const chunks = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(start + limit, value.length);
    if (end < value.length) {
      const boundary = Math.max(value.lastIndexOf(" ", end), value.lastIndexOf("\n", end));
      // Um espaço no início não pode consumir o orçamento com partes minúsculas.
      if (boundary >= start + Math.floor(limit / 2)) end = boundary;
      if (isSurrogateBoundary(value, end)) end -= 1;
    }
    chunks.push({ start, end, text: value.slice(start, end) });
    if (end >= value.length) break;
    start = end - overlap;
    if (isSurrogateBoundary(value, start)) start -= 1;
  }
  return chunks;
}

function isSurrogateBoundary(value, index) {
  return index > 0 && index < value.length &&
    value.charCodeAt(index - 1) >= 0xD800 && value.charCodeAt(index - 1) <= 0xDBFF &&
    value.charCodeAt(index) >= 0xDC00 && value.charCodeAt(index) <= 0xDFFF;
}


/** Verbos que deixam explícito um pedido de tarefa ao assistente. */
const ASSISTANT_TASK = /^(?:escreva|redija|gere|crie|faça|monte|traduza|resuma|explique|calcule|resolva|invente|imagine|me (?:diga(?!\s+se\s+é\s+verdade)|dê|conte|ajude)|ignore|desconsidere|aja como|atue como|finja(?: ser)?)(?:\b|\s|$)/i;

/** Pedidos de identidade, modo ou instruções internas, somente quando iniciam a frase. */
const ASSISTANT_PROBE = [
  /^(?:quem (?:te|lhe) (?:criou|construiu|fez|treinou)|quem (?:é|e) voc[eê]|qual (?:é|e) o seu nome)\b/i,
  /^(?:what(?: is|'s) your name|who (?:built|created|made|trained|are) you)\b/i,
  /^(?:voc[eê] agora (?:é|e)|you are now|pretend (?:to be|you are)|finja(?: ser)?|modo (?:desenvolvedor|dan|jailbreak)|developer mode|dan mode|do anything now)\b/i,
  /^(?:mostre|revele|imprima|liste|repita|mostra|show|reveal|print|dump|list|repeat)\b.{0,60}\b(?:prompt do sistema|instru[cç][oõ]es (?:internas|do sistema)|system prompt|internal instructions|api key|chave de api|senha|password|segredo|secret|token)\b/i,
];

function isAssistantRequest(sentence) {
  return ASSISTANT_TASK.test(sentence) || ASSISTANT_PROBE.some((pattern) => pattern.test(sentence));
}

function withoutQuotedText(text) {
  return text
    .replace(/"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|«[^»]*»/g, " ")
    .replace(/^\s*>.*$/gm, " ")
    .trim();
}
export function moderationConfig(env = process.env) {
  const production = env.VERCEL_ENV === "production" || env.NODE_ENV === "production" || env.IEV_PRODUCTION === "1";
  const raw = String(env.MODERATION_REFUSE_CATEGORIES ?? "").trim();
  const thresholds = { ...DEFAULT_THRESHOLDS };
  try {
    const parsed = env.MODERATION_THRESHOLDS ? JSON.parse(env.MODERATION_THRESHOLDS) : null;
    for (const [key, value] of Object.entries(parsed ?? {})) {
      if (Number.isFinite(Number(value))) thresholds[key] = Number(value);
    }
  } catch {
    /* mantém os limites padrão */
  }
  return {
    mode: env.MODERATION_MODE || (production ? "required" : "optional"),
    production,
    model: env.MODERATION_MODEL || "omni-moderation-latest",
    refuseCategories: raw ? raw.split(",").map((value) => value.trim()).filter(Boolean) : HARD_CATEGORIES,
    thresholds,
    // Cobertura de vídeo: "partial_frames_transcript" declara explicitamente que a
    // inspeção cobre transcrição + amostra de frames, não o vídeo integral.
    videoCoverage: env.MEDIA_VIDEO_MODERATION || (production ? "" : "partial_frames_transcript"),
    maxFramesChecked: Number.isFinite(Number(env.MODERATION_FRAME_SAMPLES)) ? Math.max(1, Math.round(Number(env.MODERATION_FRAME_SAMPLES))) : 4,
    timeoutMs: 20_000,
    // Mesmos resolvedores usados pela aquisição: não duplicar seus padrões aqui.
    acquisition: { input: uploadLimits(env), media: mediaLimits(env), document: evidenceConfig(env) },
  };
}

/**
 * Decide a recusa a partir das categorias/scores. Só as categorias configuradas
 * recusam; as demais ficam registradas como sinal de sensibilidade.
 */
export function decideModeration(categories = {}, scores = {}, config = moderationConfig()) {
  const matched = [];
  for (const [category, flagged] of Object.entries(categories)) {
    if (!flagged) continue;
    if (!config.refuseCategories.includes(category)) continue;
    const threshold = config.thresholds[category] ?? 0.5;
    if ((scores[category] ?? 1) >= threshold) matched.push(category);
  }
  const sensitive = Object.entries(categories).filter(([, flagged]) => flagged).map(([category]) => category);
  return { refused: matched.length > 0, matched, sensitive };
}

async function callModeration(payload, { env, fetchImpl, config }) {
  const key = env.OPENAI_API_KEY || "";
  if (!key) return { ok: false, reason: "no_key" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(OPENAI_MODERATION_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.model, ...payload }),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, reason: `http_${response.status}` };
    const data = await response.json();
    const first = Array.isArray(data?.results) ? data.results[0] : null;
    if (!first) return { ok: false, reason: "empty_result" };
    return { ok: true, categories: first.categories ?? {}, scores: first.category_scores ?? {} };
  } catch (error) {
    return { ok: false, reason: error?.name === "AbortError" ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

function outcomeFrom(result, config, what, coverage) {
  if (result.ok) {
    const decision = decideModeration(result.categories, result.scores, config);
    return {
      allowed: !decision.refused,
      refused: decision.refused,
      categories: decision.matched,
      sensitive: decision.sensitive,
      report: { checked: true, model: config.model, what, categories: decision.sensitive, coverage },
    };
  }
  const report = { checked: false, model: config.model, what, reason: result.reason, coverage };
  if (config.mode === "required") {
    return {
      allowed: false,
      error: "moderation_unavailable",
      status: 503,
      message: "Moderação de conteúdo obrigatória indisponível; a checagem não foi executada.",
      report,
    };
  }
  return { allowed: true, refused: false, categories: [], report };
}

export function refusalMessage(categories) {
  if (categories.includes("sexual/minors")) {
    return "O material foi recusado pela política de conteúdo: exploração sexual infantil não é processada nem armazenada por este serviço.";
  }
  return "O material foi recusado pela política de conteúdo (conteúdo sexual explícito). Envie a afirmação ou uma fonte jornalística sobre ela.";
}

/** Moderação de texto (afirmações enviadas e transcrições). */
export async function moderateText(text, opts = {}) {
  const env = opts.env ?? process.env;
  const config = opts.config ?? moderationConfig(env);
  const value = String(text ?? "").trim();
  const totalChars = value.length;
  // coveredChars é a união das partes respondidas com sucesso, sem contar
  // sobreposição duas vezes. Tentativas sem resposta não comprovam cobertura.
  const coverage = (chunks, attemptedChunks = 0) => {
    let coveredChars = 0;
    let coveredEnd = 0;
    for (const chunk of chunks) {
      coveredChars += Math.max(0, chunk.end - Math.max(coveredEnd, chunk.start));
      coveredEnd = Math.max(coveredEnd, chunk.end);
    }
    return {
      totalChars, coveredChars, chunks: chunks.length,
      attemptedChunks, checkedChunks: chunks.length,
      complete: coveredChars === totalChars,
    };
  };

  if (!value) return { allowed: true, refused: false, categories: [], report: { checked: false, what: "text", reason: "empty", coverage: coverage([]) } };
  if (config.mode === "off") return { allowed: true, refused: false, categories: [], report: { checked: false, what: "text", reason: "mode_off", coverage: coverage([]) } };

  const callOne = async (input) => callModeration({ input }, { env, fetchImpl: opts.fetchImpl ?? fetch, config });

  if (totalChars <= MAX_MODERATION_CHARS) {
    const result = await callOne(value);
    return outcomeFrom(result, config, "text", coverage(result.ok ? [{ start: 0, end: totalChars }] : [], 1));
  }

  const chunks = splitModerationText(value, MAX_MODERATION_CHARS, MODERATION_OVERLAP_CHARS);
  if (chunks.length > MAX_MODERATION_CHUNKS) {
    return {
      allowed: false,
      refused: false,
      categories: [],
      sensitive: [],
      error: "moderation_payload_exceeded",
      status: 413,
      message: "O conteúdo excede o orçamento de processamento da moderação; não foi analisado na íntegra.",
      report: { checked: false, model: config.model, what: "text", reason: "payload_exceeded", coverage: coverage([]) },
    };
  }

  const matched = [];
  const scores = {};
  const flagged = [];
  let refused = false;
  let failed = null;
  const processed = [];
  let attemptedChunks = 0;
  for (const chunk of chunks) {
    attemptedChunks += 1;
    const result = await callOne(chunk.text);
    if (!result.ok) {
      failed = failed ?? result.reason;
      if (config.mode === "required") break;
      continue;
    }
    processed.push(chunk);
    const decision = decideModeration(result.categories, result.scores, config);
    for (const category of decision.matched) if (!matched.includes(category)) matched.push(category);
    for (const [category, score] of Object.entries(result.scores ?? {})) {
      const current = scores[category] ?? 0;
      if (Number.isFinite(score) && score > current) scores[category] = score;
    }
    for (const [category, isFlagged] of Object.entries(result.categories ?? {})) {
      if (isFlagged && !flagged.includes(category)) flagged.push(category);
    }
    if (decision.refused) { refused = true; break; }
  }

  const decided = decideModeration(Object.fromEntries(flagged.map((category) => [category, true])), scores, config);
  const served = !failed;
  const report = {
    checked: served,
    model: config.model,
    what: "text",
    categories: decided.sensitive,
    coverage: coverage(processed, attemptedChunks),
  };
  if (failed) report.reason = failed;

  if (refused) {
    return { allowed: false, refused: true, categories: decided.matched, sensitive: decided.sensitive, report };
  }
  if (config.mode === "required" && failed) {
    return {
      allowed: false,
      refused: false,
      categories: [],
      error: "moderation_unavailable",
      status: 503,
      message: "Moderação de conteúdo obrigatória indisponível; a checagem não foi executada.",
      report,
    };
  }
  return { allowed: true, refused: false, categories: [], sensitive: decided.sensitive, report };
}

/** Moderação de imagens (upload direto e frames amostrados do vídeo). */
export async function moderateImages(images, opts = {}) {
  const env = opts.env ?? process.env;
  const config = opts.config ?? moderationConfig(env);
  const list = (Array.isArray(images) ? images : []).filter((item) => typeof item?.data === "string" && item.data.length > 0).slice(0, config.maxFramesChecked);
  if (list.length === 0) return { allowed: true, refused: false, categories: [], report: { checked: false, what: "images", reason: "empty" } };
  if (config.mode === "off") return { allowed: true, refused: false, categories: [], report: { checked: false, what: "images", reason: "mode_off" } };
  // O endpoint aceita uma imagem por requisição. Agrega sinais de todos os
  // quadros sem diluir scores nem liberar uma falha em modo obrigatório.
  const categories = {};
  const scores = {};
  for (const item of list) {
    const input = [{ type: "image_url", image_url: { url: `data:${item.mime ?? "image/jpeg"};base64,${item.data}` } }];
    const result = await callModeration({ input }, { env, fetchImpl: opts.fetchImpl ?? fetch, config });
    if (!result.ok) return outcomeFrom(result, config, `images:${list.length}`);
    for (const [category, flagged] of Object.entries(result.categories)) {
      categories[category] = Boolean(categories[category] || flagged);
    }
    for (const [category, score] of Object.entries(result.scores)) {
      scores[category] = Math.max(scores[category] ?? 0, score);
    }
  }
  return outcomeFrom({ ok: true, categories, scores }, config, `images:${list.length}`);
}

/**
 * Cobertura de moderação para vídeo: a inspeção cobre transcrição e amostra de
 * frames. Sem declaração explícita em produção, o vídeo não é processado.
 */
export function checkVideoCoverage(config = moderationConfig()) {
  if (config.mode === "off") return { allowed: true, report: { checked: false, what: "video_coverage", reason: "mode_off" } };
  if (config.videoCoverage === "partial_frames_transcript") {
    return { allowed: true, report: { checked: false, what: "video_coverage", coverage: "partial_frames_transcript" } };
  }
  // Em produção a declaração é exigida independentemente do modo de moderação:
  // sem ela, o vídeo não é processado até haver decisão explícita do produto.
  if (config.production) {
    return {
      allowed: false,
      error: "moderation_uncovered",
      status: 403,
      message: "O processamento de vídeo está desativado: a cobertura de moderação de vídeo não foi aprovada nesta implantação (defina MEDIA_VIDEO_MODERATION=partial_frames_transcript após a decisão de produto).",
      report: { checked: false, what: "video_coverage", coverage: "uncovered" },
    };
  }
  return { allowed: true, report: { checked: false, what: "video_coverage", coverage: "uncovered-dev" } };
}

/** Recusa apenas pedidos claros de tarefa, não o assunto nem indicadores incidentais. */
export function purposeTriage(input) {
  if (input?.kind !== "text") return { blocked: false };
  const text = withoutQuotedText(String(input.text ?? "")).replace(/https?:\/\/\S+/gi, " ");
  const sentences = text.split(/[.!?;\n]+(?=\s|$)/).map((sentence) => sentence.trim()).filter(Boolean);
  if (sentences.length === 0 || !sentences.every(isAssistantRequest)) return { blocked: false };
  return { blocked: true, reason: "assistant_request" };
}

/** Resumo curto para o registro de checagem (sem conteúdo sensível). */
export function moderationSummary(report) {
  if (!report) return null;
  const categories = Array.isArray(report.categories) ? report.categories.join("|") : "";
  return clip(`${report.what}:${report.checked ? "checked" : report.reason ?? "skipped"}${categories ? `:${categories}` : ""}`, 160);
}

/**
 * Identidade determinística da política de moderação vigente, sem credenciais.
 * Vincular essa identidade ao namespace de cache faz com que qualquer mudança
 * de modo, modelo, categorias de recusa, limiares, cobertura de vídeo ou
 * orçamento de texto invalide a reutilização de resultados anteriores.
 */
export function moderationPolicyIdentity(config = moderationConfig()) {
  return {
    contract: "moderation/v2",
    mode: config.mode,
    production: config.production,
    model: config.model,
    refuseCategories: [...(config.refuseCategories ?? [])].sort(),
    thresholds: config.thresholds,
    videoCoverage: config.videoCoverage,
    maxFramesChecked: config.maxFramesChecked,
    maxModerationChars: MAX_MODERATION_CHARS,
    maxModerationChunks: MAX_MODERATION_CHUNKS,
    moderationOverlapChars: MODERATION_OVERLAP_CHARS,
    acquisition: config.acquisition ?? {
      input: uploadLimits(), media: mediaLimits(), document: evidenceConfig(),
    },
  };
}

/** Hash estável da identidade da política, para uso em namespaces de cache. */
export function moderationPolicyFingerprint(config) {
  const identity = moderationPolicyIdentity(config);
  return createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")
    .slice(0, 16);
}
