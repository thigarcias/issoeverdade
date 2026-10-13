// Núcleo server-side da checagem — compartilhado entre:
// - vite.api-plugin.js (dev local)
// - api/verify.js (serverless Vercel)
// Keys (OpenAI + OpenCode) NUNCA chegam ao browser.
import { downloadAudio, downloadFrames, fetchMediaContext } from "./media.js";
import { transcribe, transcriptToPrompt } from "./transcribe.js";
import { saveCheckLog as saveLog } from "./checklog.js";
import { getCached, setCached } from "./cache.js";
import { getAiConfig, providerKey, providerUrl } from "./ai-config.js";
import {
  SYSTEM_PROMPT_FINAL,
  SYSTEM_PROMPT_JUDGE,
  validateResult,
} from "./scoring.js";

export const OPENCODE_URL = "https://opencode.ai/zen/go/v1/responses";
export const OPENAI_URL = "https://api.openai.com/v1/responses";
// Modelos de fábrica (fallback se a config de IA falhar). O painel admin
// troca provedor/modelo por passo via server/ai-config.js.
export const DEFAULT_MODEL = "muse-spark-1.3-contributor";
export const FALLBACK_MODEL = "gpt-6-luna";
export function buildUserContent(input, mediaContext = "") {
  const text = String(input?.text ?? "").slice(0, 8000);
  const fileName = input?.fileName ? String(input.fileName).slice(0, 200) : null;
  if (input?.kind === "link") {
    if (mediaContext) {
      return `Cheque este link: ${text}\n\nConteúdo extraído da página (confie nestes dados, não na URL):\n${mediaContext}`;
    }
    return `Cheque este link (analise a URL e descreva o que se pode inferir dela; se não houver conteúdo acessível, peça mídia em vez de chutar): ${text}`;
  }
  if (input?.kind === "video") {
    const link = /^https?:\/\//.test(text) ? text : "";
    if (link && mediaContext) {
      return `Cheque este vídeo/áudio: ${link}\n\nMetadados extraídos do post (confie nestes dados):\n${mediaContext}\n\nSe os metadados não trazem o conteúdo falado, peça mídia para receber a transcrição.`;
    }
    return `Cheque este vídeo/áudio${fileName ? ` (arquivo: ${fileName})` : ""}. Como não tenho o áudio, analise a descrição/link: ${text || "(sem descrição — peça mídia)"}. Se for link de rede social, peça mídia para receber metadados e transcrição.`;
  }
  if (input?.kind === "image") {
    return `Cheque esta imagem${fileName ? ` (arquivo: ${fileName})` : ""}. Como não vejo a imagem, analise a descrição: ${text || "(sem descrição — peça mídia)"}.`;
  }
  return `Cheque este texto:\n\n${text}`;
}

export function extractText(response) {
  let text = "";
  for (const item of response?.output ?? []) {
    if (item?.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part?.type === "output_text" && typeof part.text === "string") {
        text += part.text;
      }
    }
  }
  return text;
}

function fail(status, error, extra = {}) {
  const err = new Error(error);
  err.status = status;
  err.payload = { error, ...extra };
  throw err;
}

function parseModelJson(content, mdl) {
  const jsonStart = content.indexOf("{");
  const jsonEnd = content.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd <= jsonStart) {
    fail(502, "model_bad_json", { model: mdl, raw: content.slice(0, 500) });
  }
  try {
    return JSON.parse(content.slice(jsonStart, jsonEnd + 1));
  } catch {
    fail(502, "model_bad_json", { model: mdl, raw: content.slice(0, 500) });
  }
}

// Chamada genérica à Responses API de qualquer provedor configurado.
// Ambos os provedores (OpenCode Go e OpenAI) falam o mesmo protocolo:
// Responses API com web_search. Modelos vêm da config de IA (admin).
async function callResponses({ url, key, model, instructions, input, timeoutMs, maxTokens = 8000, webSearch = true }) {
  if (!key) fail(503, "missing_provider_key", { message: "Chave do provedor de IA não configurada.", model });
  const isGo = /opencode\.ai/.test(url ?? "");
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "User-Agent": "issoeverdade/0.1",
        ...(isGo ? { "x-opencode-session": `iev-${Date.now().toString(36)}` } : {}),
      },
      body: JSON.stringify({
        model,
        instructions,
        input,
        ...(webSearch ? { tools: isGo ? [{ type: "web_search" }] : [{ type: "web_search", search_context_size: "medium" }] } : {}),
        max_output_tokens: maxTokens,
        ...(isGo ? { reasoning: { effort: "low" } } : {}),
      }),
      signal: ctrl.signal,
    });
    const raw = await upstream.text();
    if (!upstream.ok) {
      let code = "upstream_error";
      try {
        const p = JSON.parse(raw);
        code = p?.error?.code ?? p?.error?.type ?? p?.type ?? code;
      } catch { /* mantém genérico */ }
      fail(502, code, { message: raw.slice(0, 500), model });
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail(502, "upstream_bad_json", { model });
    }
    const text = extractText(parsed);
    return { text, raw: text };
  } catch (err) {
    if (err?.payload) throw err;
    if (err?.name === "AbortError") fail(504, "upstream_timeout", { model });
    fail(502, "upstream_fetch_failed", { model });
  } finally {
    clearTimeout(timeout);
  }
}

async function callJson({ pair, instructions, input, timeoutMs }) {
  const { text, raw } = await callResponses({
    url: providerUrl(pair.provider),
    key: providerKey(pair.provider),
    model: pair.model,
    instructions,
    input,
    timeoutMs,
  });
  return { result: parseModelJson(text, pair.model), raw };
}

// Passo de julgamento com config de IA: tenta o par configurado; se ele
// for do OpenCode e falhar, tenta a Luna (OpenAI) como rede de segurança —
// salvo quando a própria config já usa OpenAI (sem retry redundante).
async function callModel({ aiCfg, step, instructions, input, timeoutMs }) {
  const pair = aiCfg?.[step] ?? { provider: "opencode", model: DEFAULT_MODEL };
  try {
    const { result, raw } = await callJson({ pair, instructions, input, timeoutMs });
    return { result, model: pair.model, provider: pair.provider, raw };
  } catch (err) {
    const fallbackKey = process.env.OPENAI_API_KEY || "";
    if (pair.provider === "openai" || !fallbackKey) throw err;
    console.error(`[iev] ${pair.model} falhou (${err?.payload?.error ?? err?.message}), usando fallback Luna`);
    const fb = { provider: "openai", model: FALLBACK_MODEL };
    const { result, raw } = await callJson({ pair: fb, instructions, input, timeoutMs });
    return { result, model: fb.model, provider: fb.provider, raw };
  }
}

/**
 * Sanitiza fontes do modelo: remove outlets duplicados (case-insensitive),
 * rejeita URLs genéricas (homepage/raiz/seção) e DESCARTA fontes sem URL
 * válida (HEAD rápido, 8s; falha = remove). Com `claims` (vínculos 1-based
 * no campo `sources` de cada claim), poda fontes ÓRFÃS — não vinculadas a
 * nenhum claim — e remapeia os vínculos para os índices finais (0-based).
 * Fonte sem link clicável não entra na lista — nome sem URL não é fonte.
 * @returns {{ sources: object[], dropped: string[] }}
*/
async function sanitizeSources(sources, claims = null) {
  if (!Array.isArray(sources)) return { sources: [], dropped: [] };
  const seen = new Set();
  const unique = [];
  const dropped = [];
  const capped = sources.slice(0, 8);
  for (let si = 0; si < capped.length; si++) {
    const s = capped[si];
    const key = String(s?.outlet ?? "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const url = typeof s?.url === "string" && /^https?:\/\//.test(s.url) ? s.url : "";
    if (!url) {
      dropped.push(`${s.outlet} (sem URL)`);
      continue;
    }
    // Homepage/raiz/seção não é fonte: matéria real tem path com slug (≥2 níveis
    // ou 1 longo), query com id (?v=, ?p=) ou shortlink de vídeo (youtu.be).
    let deep = false;
    try {
      const u = new URL(url);
      const segs = u.pathname.split("/").filter(Boolean);
      const q = u.searchParams;
      const hasId = ["v", "id", "p", "vid", "video", "watch", "post", "article"].some((k) => q.has(k));
      deep = segs.length >= 2 || (segs.length === 1 && segs[0].length > 24) || hasId || u.hostname === "youtu.be";
    } catch { deep = true; /* URL malformada: probe abaixo decide */ }
    if (!deep) {
      dropped.push(`${s.outlet} (URL genérica, sem matéria)`);
      continue;
    }
    unique.push({
      _orig: si + 1,
      outlet: String(s.outlet).slice(0, 120),
      detail: String(s?.detail ?? "").slice(0, 120),
      url,
    });
  }
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
  const alive = await Promise.all(
    unique.map(async (s) => {
      // HEAD com UA de browser; servidores sem HEAD (405/501) ganham retry de GET leve.
      async function probe(method) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        try {
          return await fetch(s.url, {
            method,
            signal: ctrl.signal,
            redirect: "follow",
            headers: { "User-Agent": UA, ...(method === "GET" ? { Range: "bytes=0-1023" } : {}) },
          });
        } finally {
          clearTimeout(t);
        }
      }
      try {
        let res = await probe("HEAD");
        if (res.status === 405 || res.status === 501) res = await probe("GET");
        if (!res.ok) {
          dropped.push(`${s.outlet} (HTTP ${res.status})`);
          return null;
        }
        return s;
      } catch {
        dropped.push(`${s.outlet} (inacessível)`);
        return null;
      }
    }),
  );
  let final = alive.filter(Boolean);
  // Poda órfãs: mantém só fontes vinculadas a ≥1 claim; remapeia vínculos.
  // Sem vínculos (modelo antigo): mantém todas (compat).
  if (Array.isArray(claims)) {
    const used = new Set();
    for (const c of claims) {
      const refs = Array.isArray(c?.sources) ? c.sources : [];
      for (const n of refs) {
        const idx = Number(n) - 1;
        if (Number.isInteger(idx)) used.add(idx);
      }
    }
    const anyRefs = used.size > 0;
    if (anyRefs) {
      const kept = [];
      const remap = new Map();
      final.forEach((s) => {
        if (used.has(s._orig - 1)) { remap.set(s._orig, kept.length); kept.push(s); }
        else dropped.push(s.outlet + ' (não vinculada a nenhum claim)');
      });
      for (const c of claims) {
        const refs = Array.isArray(c?.sources) ? c.sources : [];
        c.sourceIds = refs.map((n) => remap.get(Number(n))).filter((v) => v !== undefined);
      }
      final = kept;
    } else {
      for (const c of claims) c.sourceIds = [];
    }
  }
  for (const s of final) delete s._orig;
  return { sources: final, dropped };
}

/**
 * Analisa frames do vídeo com o modelo de visão — OCR do texto na tela +
 * descrição das cenas. Usado quando o vídeo não tem fala (só música/trilha).
 * Usa o par "vision" da config de IA (admin); Luna como rede de segurança.
 * @param {string[]} frames JPEGs em base64, na ordem temporal.
 * @returns {Promise<string|null>} "[frame N] TEXTO: ... | CENA: ..." por linha.
 */
async function describeFrames(frames, { aiCfg, timeoutMs = 120_000 } = {}) {
  if (!Array.isArray(frames) || frames.length === 0) return null;
  const instructions = `Você analisa frames, em ordem, de um vídeo de política brasileira que NÃO tem fala (só música ou trilha). Para CADA frame: extraia LITERALMENTE todo texto visível (títulos, legendas queimadas, marca d'água, assinatura de propaganda eleitoral) e descreva a cena em 1 frase curta. Formato exato, uma linha por frame: "[frame N] TEXTO: <texto literal ou (nenhum)> | CENA: <descrição>". Sem markdown, sem introdução, sem comentários.`;
  const content = [{ type: "input_text", text: `Analise os ${frames.length} frames na ordem em que aparecem:` }];
  for (const f of frames) content.push({ type: "input_image", image_url: `data:image/jpeg;base64,${f}` });
  const input = [{ role: "user", content }];
  const pair = aiCfg?.vision ?? { provider: "opencode", model: DEFAULT_MODEL };
  async function attempt(p) {
    const { text } = await callResponses({
      url: providerUrl(p.provider),
      key: providerKey(p.provider),
      model: p.model,
      instructions,
      input,
      timeoutMs,
      maxTokens: 4000,
      webSearch: false,
    });
    const clean = text.trim();
    return clean ? clean.slice(0, 6000) : null;
  }
  const first = await attempt(pair).catch(() => null);
  if (first) return first;
  if (pair.provider !== "openai" && providerKey("openai")) {
    return await attempt({ provider: "openai", model: FALLBACK_MODEL }).catch(() => null);
  }
  return null;
}

function toOrigin(media, url) {
  if (!media) return null;
  const out = {
    url,
    platform: String(media.platform ?? media.source ?? "").slice(0, 80) || null,
    title: String(media.title ?? "").slice(0, 200) || null,
    author: String(media.author ?? "").slice(0, 120) || null,
    thumbnail: typeof media.thumbnail === "string" && /^https?:\/\//.test(media.thumbnail) ? media.thumbnail : null,
  };
  return out.title || out.thumbnail ? out : null;
}

async function enrichWithMedia(maybeUrl, opts = {}) {
  // Retorna { mediaContext, transcript, debug } — probe e áudio em paralelo.
  const looksVideo = /(\.mp4|\.mov|reel|youtu\.?be|tiktok|twitter|x\.com\/.*status|vimeo|twitch|instagram\.com)/i.test(maybeUrl);
  const [media, dl] = await Promise.all([
    fetchMediaContext(maybeUrl),
    looksVideo ? downloadAudio(maybeUrl) : Promise.resolve({ ok: false, reason: "not-video" }),
  ]);
  let mediaContext = media.ok ? media.context : "";
  let transcript = null;
  const debug = [...media.attempts];
  debug.push(`audio:${dl.ok ? `${dl.via}:${dl.file}` : dl.reason}`);
  if (dl.ok) {
    const t = await transcribe(dl.file, { model: opts.aiCfg?.transcribe?.model });
    debug.push(`whisper:${t.ok ? `${t.segments?.length ?? 0} segs` : t.reason}`);
    if (t.ok && t.text) {
      transcript = t;
      mediaContext += `\n\nTranscrição do áudio (Whisper ${t.model}):\n${transcriptToPrompt(t)}`;
    }
  }
  // Vídeo sem fala (só música/trilha): o conteúdo costuma estar no TEXTO NA TELA.
  // Nesse caso, extrai frames e roda OCR/visão para capturar a mensagem real.
  const spoken = (transcript?.text ?? "").replace(/[^\p{L}\p{N}]/gu, "");
  if (looksVideo && spoken.length < 12) {
    const fr = await downloadFrames(maybeUrl);
    debug.push(`frames:${fr.ok ? `${fr.via}:${fr.count}` : fr.reason}`);
    if (fr.ok) {
      const vision = await describeFrames(fr.frames, { aiCfg: opts.aiCfg, timeoutMs: opts.timeoutMs });
      debug.push(`vision:${vision ? "ok" : "failed"}`);
      if (vision) {
        mediaContext += `\n\nVídeo sem fala — texto na tela e cenas (análise visual frame a frame):\n${vision}`;
      }
    }
  }
  return { mediaContext: mediaContext.trim(), transcript, debug, origin: toOrigin(media.ok ? media.media : null, maybeUrl) };
}

/**
 * Executa a checagem via OpenCode Go, em até 2 passes:
 * 1. julga com metadados do link (rápido); vídeo sempre ganha transcrição.
 * 2. se a IA pedir mídia (needs_media), baixa + transcreve e rejulga.
 * @returns {{ result: object, model: string, media: string[], transcript: object|null }}
 */
export async function runVerify(input, opts = {}) {
  try {
    return await runVerifyInner(input, opts);
  } catch (err) {
    // Erros também vão pro admin (com filtro "Com erro").
    const code = err?.payload?.error ?? err?.message ?? "unknown";
    await Promise.race([
      saveLog({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        kind: input?.kind,
        inputPreview: String(input?.text ?? ""),
        fileName: input?.fileName ? String(input.fileName) : null,
        phases: [],
        totalMs: null,
        model: err?.payload?.model ?? null,
        verdict: null,
        score: null,
        summary: "",
        claims: [],
        sources: [],
        claimsCount: 0,
        sourcesCount: 0,
        mediaAttempts: [],
        transcriptSegs: 0,
        transcriptPreview: "",
        origin: null,
        judgePromptPreview: "",
        judgeRawPreview: "",
        finalPromptPreview: "",
        finalRawPreview: String(err?.payload?.message ?? err?.message ?? "").slice(0, 2000),
        corrections: [],
        error: String(code).slice(0, 200),
      }).catch(() => {}),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
    throw err;
  }
}

async function runVerifyInner(input, { timeoutMs = 120_000 } = {}) {
  // Config de IA (admin): qual provedor/modelo cada passo usa. Falha = fábrica.
  const aiCfg = await getAiConfig().catch(() => null);
  if (!providerKey("opencode") && !providerKey("openai")) {
    fail(503, "missing_api_key", { message: "Nenhuma chave de IA configurada no servidor." });
  }
  // Cache: mesma entrada em <24h = resultado idêntico, sem custo.
  // Ainda assim registra no admin (com novo id) para auditoria completa.
  const t0 = Date.now();
  const hit = await getCached(input).catch(() => null);
  if (hit) {
    const hitId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    await Promise.race([
      saveLog({
        id: hitId,
        kind: input?.kind,
        inputPreview: String(input?.text ?? ""),
        fileName: input?.fileName ? String(input.fileName) : null,
        phases: [{ name: "cache-hit", ms: Date.now() - t0, ok: true }],
        totalMs: Date.now() - t0,
        model: hit.model ?? null,
        verdict: hit.result?.verdict ?? null,
        score: typeof hit.result?.score === "number" ? hit.result.score : null,
        summary: hit.result?.summary ?? "",
        claims: hit.result?.claims ?? [],
        sources: hit.result?.sources ?? [],
        claimsCount: hit.result?.claims?.length ?? 0,
        sourcesCount: hit.result?.sources?.length ?? 0,
        mediaAttempts: hit.media ?? [],
        transcriptSegs: hit.transcript?.segments?.length ?? 0,
        transcriptPreview: "",
        origin: hit.origin ?? null,
        judgePromptPreview: "",
        judgeRawPreview: "",
        finalPromptPreview: "",
        finalRawPreview: "",
        corrections: [],
        error: null,
        cachedFrom: hit.checkId ?? null,
      }).catch(() => {}),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
    return { ...hit, checkId: hitId, cached: true };
  }
  const phases = [];
  async function phase(name, fn) {
    const start = Date.now();
    try {
      const out = await fn();
      phases.push({ name, ms: Date.now() - start, ok: true });
      return out;
    } catch (err) {
      phases.push({ name, ms: Date.now() - start, ok: false, error: String(err?.payload?.error ?? err?.message ?? err).slice(0, 200) });
      throw err;
    }
  }
  const maybeUrl = String(input?.text ?? "").trim();
  const isUrl = /^https?:\/\//.test(maybeUrl);
  const wantsMedia = input?.kind === "link" || input?.kind === "video";

  // Passo 1 — metadados rápidos (yt-dlp probe / oEmbed / OpenGraph).
  let mediaContext = "";
  let transcript = null;
  let mediaDebug = [];
  let origin = null;
  if (wantsMedia && isUrl) {
    await phase("media-probe", async () => {
      try {
        const media = await fetchMediaContext(maybeUrl);
        mediaDebug = media.attempts;
        if (media.ok) {
          mediaContext = media.context;
          origin = toOrigin(media.media, maybeUrl);
        }
      } catch {
        mediaDebug = ["media-kit-crashed"];
      }
    });
  }
  const judgeInput = buildUserContent(input, mediaContext);
  let { result: first, model: firstModel, provider: firstProvider, raw: firstRaw } = await phase("judge", () =>
    callModel({
      aiCfg,
      step: "judge",
      instructions: SYSTEM_PROMPT_JUDGE,
      input: judgeInput,
      timeoutMs,
    }),
  );
  // Retry cruzado: o modelo do passo às vezes pede mídia para texto checável —
  // a Luna (outro provedor) tenta antes de desistir.
  if (first?.needs_media === true && !wantsMedia && firstProvider === "opencode" && providerKey("openai")) {
    const retry = await phase("judge-retry", () =>
      callJson({
        pair: { provider: "openai", model: FALLBACK_MODEL },
        instructions: SYSTEM_PROMPT_JUDGE,
        input: judgeInput,
        timeoutMs,
      }),
    ).catch(() => null);
    if (retry && retry.result?.needs_media !== true) {
      first = retry.result;
      firstModel = FALLBACK_MODEL;
      firstProvider = "openai";
      firstRaw = retry.raw;
    }
  }

  // Passo 2 — a IA pediu mais? Baixa áudio + transcreve + rejulga.
  // Vídeo com URL sempre passa pelo passo 2 (transcrição é obrigatória).
  const mustTranscribe =
    wantsMedia && isUrl && (first?.needs_media === true || (input?.kind === "video" && !transcript));
  if (mustTranscribe) {
    await phase("enrich", async () => {
      try {
        const enriched = await enrichWithMedia(maybeUrl, { aiCfg, timeoutMs });
        mediaDebug = [...mediaDebug, ...enriched.debug];
        if (enriched.mediaContext && enriched.mediaContext !== mediaContext) {
          mediaContext = enriched.mediaContext;
        }
        if (enriched.origin && !origin) origin = enriched.origin;
        transcript = enriched.transcript;
      } catch {
        mediaDebug.push("enrich-crashed");
      }
    });
    if (transcript || mediaContext) {
      const kindLabel = input?.kind === "video" ? "vídeo/áudio" : "link";
      const finalInput = `Cheque este ${kindLabel}: ${maybeUrl}\n\nDados extraídos (confie nestes dados):\n${mediaContext}`;
      const { result: second, model: secondModel, provider: secondProvider, raw: secondRaw } = await phase("final", () =>
        callModel({
          aiCfg,
          step: "final",
          instructions: SYSTEM_PROMPT_FINAL,
          input: finalInput,
          timeoutMs,
        }),
      );
      const clean = await sanitizeSources(second.sources, second.claims);
      second.sources = clean.sources;
      return await finish({ result: second, model: secondModel, provider: secondProvider, debug: { finalInput, secondRaw }, dropped: clean.dropped });
    }
  }

  if (first?.needs_media === true && !transcript) {
    // IA pediu mídia mas não conseguimos extrair nada: veredito honesto.
    return await finish({
      result: {
        verdict: "unproven",
        score: 30,
        summary: `Não consegui acessar o conteúdo (${first.reason ?? "sem dados"}). Cole o texto ou suba o arquivo para checar.`,
        claims: [],
        sources: [],
      },
      model: firstModel,
      provider: firstProvider,
    });
  }
  const clean = await sanitizeSources(first.sources, first.claims);
  first.sources = clean.sources;
  return await finish({ result: first, model: firstModel, provider: firstProvider, dropped: clean.dropped });

  async function finish({ result, model, provider = null, debug, dropped = [] }) {
    const totalMs = Date.now() - t0;
    const checkId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const usedCfg = {};
    for (const s of ["judge", "final", "vision", "transcribe"]) {
      if (aiCfg?.[s]) usedCfg[s] = `${aiCfg[s].provider}:${aiCfg[s].model}`;
    }
    // Validação determinística: recalcula score/veredito pela rubrica.
    const { fixed, corrections } = validateResult(result);
    if (dropped.length > 0) {
      corrections.push(`fontes descartadas (${dropped.length}): ${dropped.join(" · ")}`);
    }
    if (corrections.length > 0) {
      phases.push({ name: "score-fix", ms: 0, ok: true, corrections });
    }
    // Log aguardado (até 8s): fire-and-forget morre no freeze da serverless.
    const entry = {
      id: checkId,
      kind: input?.kind,
      inputPreview: String(input?.text ?? ""),
      fileName: input?.fileName ? String(input.fileName) : null,
      phases,
      totalMs,
      model,
      provider,
      aiConfig: usedCfg,
      verdict: fixed?.verdict ?? null,
      score: typeof fixed?.score === "number" ? fixed.score : null,
      summary: fixed?.summary ?? "",
      claims: fixed?.claims ?? [],
      sources: fixed?.sources ?? [],
      claimsCount: Array.isArray(fixed?.claims) ? fixed.claims.length : 0,
      sourcesCount: Array.isArray(fixed?.sources) ? fixed.sources.length : 0,
      mediaAttempts: mediaDebug,
      transcriptSegs: transcript?.segments?.length ?? 0,
      transcriptPreview: transcriptToPrompt(transcript),
      origin,
      judgePromptPreview: judgeInput,
      judgeRawPreview: firstRaw ?? "",
      finalPromptPreview: debug?.finalInput ?? "",
      finalRawPreview: debug?.secondRaw ?? "",
      corrections,
      error: null,
    };
    await Promise.race([
      saveLog(entry).catch(() => {}),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
    const out = { result: fixed, model, provider, media: mediaDebug, transcript, origin, checkId, totalMs };
    setCached(input, out).catch(() => {});
    return out;
  }
}
