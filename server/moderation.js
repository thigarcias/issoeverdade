// Triagem de propósito e moderação de conteúdo sensível.
// Regra de produto: checar afirmações públicas sobre temas difíceis é permitido;
// recusar só o que não pode ser processado/redistribuído (abuso sexual infantil,
// conteúdo sexual explícito) e pedidos diretos ao assistente. O resto é marcado
// como sensível e registrado, nunca usado como motivo de recusa por si só.
// Falha da moderação em produção = recusa (fail-closed), nunca liberação.
import { clip } from "./text.js";

const OPENAI_MODERATION_URL = "https://api.openai.com/v1/moderations";
const HARD_CATEGORIES = ["sexual/minors", "sexual"];
const DEFAULT_THRESHOLDS = { "sexual/minors": 0.1, sexual: 0.7 };
const MAX_TEXT_CHARS = 4000;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

/** Pedido direto ao assistente, sem conteúdo factual verificável. */
const ASSISTANT_REQUEST = /^(escreva|redija|gere|crie|faça|monte|traduza|resuma|explique|calcule|resolva|invente|imagine|me (diga|dê|conte|ajude)|qual (é|e) a sua|quem é você|ignore|desconsidere|aja como|atue como|finja|finja ser)\b/i;

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

function outcomeFrom(result, config, what) {
  if (result.ok) {
    const decision = decideModeration(result.categories, result.scores, config);
    return {
      allowed: !decision.refused,
      refused: decision.refused,
      categories: decision.matched,
      sensitive: decision.sensitive,
      report: { checked: true, model: config.model, what, categories: decision.sensitive },
    };
  }
  const report = { checked: false, model: config.model, what, reason: result.reason };
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
  if (!value) return { allowed: true, refused: false, categories: [], report: { checked: false, what: "text", reason: "empty" } };
  if (config.mode === "off") return { allowed: true, refused: false, categories: [], report: { checked: false, what: "text", reason: "mode_off" } };
  const result = await callModeration({ input: value.slice(0, MAX_TEXT_CHARS) }, { env, fetchImpl: opts.fetchImpl ?? fetch, config });
  return outcomeFrom(result, config, "text");
}

/** Moderação de imagens (upload direto e frames amostrados do vídeo). */
export async function moderateImages(images, opts = {}) {
  const env = opts.env ?? process.env;
  const config = opts.config ?? moderationConfig(env);
  const list = (Array.isArray(images) ? images : []).filter((item) => typeof item?.data === "string" && item.data.length > 0).slice(0, config.maxFramesChecked);
  if (list.length === 0) return { allowed: true, refused: false, categories: [], report: { checked: false, what: "images", reason: "empty" } };
  if (config.mode === "off") return { allowed: true, refused: false, categories: [], report: { checked: false, what: "images", reason: "mode_off" } };
  const input = list.map((item) => ({
    type: "image_url",
    image_url: { url: `data:${item.mime ?? "image/jpeg"};base64,${item.data}` },
  }));
  const result = await callModeration({ input }, { env, fetchImpl: opts.fetchImpl ?? fetch, config });
  return outcomeFrom(result, config, `images:${list.length}`);
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

/** Pedido direto ao assistente não é afirmação verificável. */
export function purposeTriage(input) {
  if (input?.kind !== "text") return { blocked: false };
  const text = String(input.text ?? "").trim();
  if (!text || text.length > 600) return { blocked: false };
  if (/https?:\/\//i.test(text) || /\d/.test(text)) return { blocked: false };
  if (!ASSISTANT_REQUEST.test(text)) return { blocked: false };
  return { blocked: true, reason: "assistant_request" };
}

/** Moderação aplicada antes das etapas caras, conforme a modalidade. */
export async function moderateInput(input, opts = {}) {
  const env = opts.env ?? process.env;
  const config = opts.config ?? moderationConfig(env);
  const purpose = purposeTriage(input);
  if (purpose.blocked) return { allowed: true, purpose, report: { checked: false, what: "purpose", reason: purpose.reason } };
  if (input?.kind === "image" && Buffer.isBuffer(input.fileBuffer)) {
    if (input.fileBuffer.length > MAX_IMAGE_BYTES) {
      return { allowed: false, error: "moderation_unavailable", status: 413, message: "Imagem acima do limite para triagem de conteúdo." };
    }
    const result = await moderateImages([{ data: input.fileBuffer.toString("base64"), mime: input.fileMime }], { env, config, fetchImpl: opts.fetchImpl });
    if (!result.allowed) {
      return { allowed: false, error: "content_refused", status: 403, message: refusalMessage(result.categories), categories: result.categories, report: result.report };
    }
    return { allowed: true, purpose, report: result.report };
  }
  const text = input?.kind === "text" || input?.kind === "link" ? String(input.text ?? "") : "";
  if (text && input?.kind === "text") {
    const result = await moderateText(text, { env, config, fetchImpl: opts.fetchImpl });
    if (!result.allowed) {
      return {
        allowed: false,
        error: result.error ?? "content_refused",
        status: result.status ?? 403,
        message: result.message ?? refusalMessage(result.categories),
        categories: result.categories,
        report: result.report,
      };
    }
    return { allowed: true, purpose, report: result.report };
  }
  return { allowed: true, purpose, report: { checked: false, what: input?.kind ?? "unknown", reason: "deferred" } };
}

/** Resumo curto para o registro de checagem (sem conteúdo sensível). */
export function moderationSummary(report) {
  if (!report) return null;
  const categories = Array.isArray(report.categories) ? report.categories.join("|") : "";
  return clip(`${report.what}:${report.checked ? "checked" : report.reason ?? "skipped"}${categories ? `:${categories}` : ""}`, 160);
}
