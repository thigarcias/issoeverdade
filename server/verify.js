// Núcleo server-side da checagem — compartilhado entre:
// - vite.api-plugin.js (dev local)
// - api/verify.js (serverless Vercel)
// Keys (OpenAI + OpenCode) NUNCA chegam ao browser.
import { downloadAudio, fetchMediaContext } from "./media.js";
import { transcribe, transcriptToPrompt } from "./transcribe.js";

export const OPENCODE_URL = "https://opencode.ai/zen/go/v1/responses";
export const OPENAI_URL = "https://api.openai.com/v1/responses";
export const DEFAULT_MODEL = "gpt-6-luna"; // OpenAI com web_search nativo
export const FALLBACK_MODEL = "muse-spark-1.3-contributor"; // OpenCode Go, sem busca

const BASE_RULES = `Regras: separe cada afirmação checável do conteúdo; "context" quando a frase é parcialmente verdadeira mas engana sem contexto; seja cético com prints sem origem e correntes de WhatsApp; USE A BUSCA NA WEB para verificar cada afirmação com dados atuais (não confie só na memória) — busque nomes, datas, números e eventos citados; cite no mínimo 3 fontes VARIADAS por checagem vindas dos resultados da busca, nunca repetindo o mesmo outlet — alterne entre: fontes oficiais (TSE, Câmara, Senado, Planalto, STF, IBGE, Banco Central), agências de checagem (Lupa, Aos Fatos, Estadão Verifica, UOL Confere, AFP Checamos), veículos grandes (G1, Folha, Estadão, O Globo, UOL, Poder360, Metrópoles, CNN Brasil) e regionais quando relevante; cada URL deve ser REAL, copiada dos resultados da busca (nunca invente); score geral pondera a gravidade de cada afirmação. Tudo em pt-BR.`;

const RESULT_SHAPE = `{"verdict":"true|mostly_true|mixed|unproven|misleading|false","score":0-100,"summary":"resumo em pt-BR, 1-2 frases","claims":[{"status":"true|false|unproven|context","score":0-100,"text":"a afirmação entre aspas","note":"justificativa curta em pt-BR"}],"sources":[{"outlet":"nome da fonte","detail":"tipo · data","url":"https://..."}]}`;

// Passo 1: julga com o que tem; se faltar conteúdo (vídeo sem transcrição,
// link sem texto), pede mídia em vez de chutar.
export const SYSTEM_PROMPT_JUDGE = `Você é o verificador de fatos do "isso é verdade?", especializado na política do Brasil, segundo turno das Eleições 2026. Responda ESTRITAMENTE em JSON válido, sem markdown, sem texto fora do JSON.
Se o conteúdo abaixo for suficiente para checar, responda neste formato exato:
${RESULT_SHAPE}
Se NÃO for suficiente (ex.: link de vídeo sem transcrição, post sem texto, imagem sem descrição), responda APENAS:
{"needs_media":true,"reason":"motivo curto em pt-BR"}
${BASE_RULES}`;

// Passo 2: rejulga com transcrição/mídia extraída — aqui o veredito é final.
export const SYSTEM_PROMPT_FINAL = `Você é o verificador de fatos do "isso é verdade?", especializado na política do Brasil, segundo turno das Eleições 2026. Responda ESTRITAMENTE em JSON válido, sem markdown, sem texto fora do JSON, com este formato exato:
${RESULT_SHAPE}
${BASE_RULES}
Quando houver transcrição com timestamps, cheque frase por frase da transcrição.`;

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

async function callOpenAI({ instructions, input, timeoutMs }) {
  const key = process.env.OPENAI_API_KEY || "";
  if (!key) fail(503, "missing_openai_key", { message: "OPENAI_API_KEY não configurada." });
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const upstream = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        instructions,
        input,
        tools: [{ type: "web_search", search_context_size: "medium" }],
        max_output_tokens: 8000,
      }),
      signal: ctrl.signal,
    });
    const raw = await upstream.text();
    if (!upstream.ok) {
      let code = "openai_error";
      try {
        const p = JSON.parse(raw);
        code = p?.error?.code ?? p?.error?.type ?? code;
      } catch { /* mantém genérico */ }
      fail(502, code, { message: raw.slice(0, 500), model: DEFAULT_MODEL });
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail(502, "upstream_bad_json", { model: DEFAULT_MODEL });
    }
    return parseModelJson(extractText(parsed), DEFAULT_MODEL);
  } catch (err) {
    if (err?.payload) throw err;
    if (err?.name === "AbortError") fail(504, "upstream_timeout", { model: DEFAULT_MODEL });
    fail(502, "upstream_fetch_failed", { model: DEFAULT_MODEL });
  } finally {
    clearTimeout(timeout);
  }
}

async function callGo({ apiKey, instructions, input, timeoutMs }) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const upstream = await fetch(OPENCODE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "issoeverdade/0.1",
        "x-opencode-session": `iev-${Date.now().toString(36)}`,
      },
      body: JSON.stringify({
        model: FALLBACK_MODEL,
        instructions,
        input,
        max_output_tokens: 3000,
        temperature: 0.2,
        reasoning: { effort: "low" },
      }),
      signal: ctrl.signal,
    });
    const raw = await upstream.text();
    if (!upstream.ok) {
      let code = "upstream_error";
      try {
        const parsed = JSON.parse(raw);
        code = parsed?.error?.type ?? parsed?.type ?? code;
      } catch { /* mantém genérico */ }
      fail(502, code, { message: raw.slice(0, 500), model: FALLBACK_MODEL });
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail(502, "upstream_bad_json", { model: FALLBACK_MODEL });
    }
    return parseModelJson(extractText(parsed), FALLBACK_MODEL);
  } catch (err) {
    if (err?.payload) throw err;
    if (err?.name === "AbortError") fail(504, "upstream_timeout", { model: FALLBACK_MODEL });
    fail(502, "upstream_fetch_failed", { model: FALLBACK_MODEL });
  } finally {
    clearTimeout(timeout);
  }
}

async function callModel({ apiKey, instructions, input, timeoutMs }) {
  // GPT Luna (com web_search) primeiro; Muse Spark (Go) como fallback.
  try {
    const result = await callOpenAI({ instructions, input, timeoutMs });
    return { result, model: DEFAULT_MODEL };
  } catch (openaiErr) {
    if (!apiKey) throw openaiErr;
    if (openaiErr?.payload?.error === "missing_openai_key") throw openaiErr;
    console.error(`[iev] Luna falhou (${openaiErr?.payload?.error ?? openaiErr?.message}), usando fallback Go`);
    const result = await callGo({ apiKey, instructions, input, timeoutMs });
    return { result, model: FALLBACK_MODEL };
  }
}

/**
 * Sanitiza fontes do modelo: remove outlets duplicados (case-insensitive) e
 * marca URLs inalcançáveis como "#" (HEAD rápido, 8s; falha = mantém texto).
 */
async function sanitizeSources(sources) {
  if (!Array.isArray(sources)) return [];
  const seen = new Set();
  const unique = [];
  for (const s of sources.slice(0, 8)) {
    const key = String(s?.outlet ?? "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push({
      outlet: String(s.outlet).slice(0, 120),
      detail: String(s?.detail ?? "").slice(0, 120),
      url: typeof s?.url === "string" && /^https?:\/\//.test(s.url) ? s.url : "#",
    });
  }
  await Promise.all(
    unique.map(async (s) => {
      if (s.url === "#") return;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(s.url, { method: "HEAD", signal: ctrl.signal, redirect: "follow" });
        clearTimeout(t);
        if (!res.ok) s.url = "#";
      } catch {
        s.url = "#";
      }
    }),
  );
  return unique;
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

async function enrichWithMedia(maybeUrl) {
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
    const t = await transcribe(dl.file);
    debug.push(`whisper:${t.ok ? `${t.segments?.length ?? 0} segs` : t.reason}`);
    if (t.ok && t.text) {
      transcript = t;
      mediaContext += `\n\nTranscrição do áudio (Whisper ${t.model}):\n${transcriptToPrompt(t)}`;
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
export async function runVerify(input, { apiKey, timeoutMs = 120_000 } = {}) {
  // OpenAI (Luna) é o primário; Go (Muse) é fallback. Pelo menos um precisa existir.
  if (!apiKey && !process.env.OPENAI_API_KEY) {
    fail(503, "missing_api_key", { message: "Nenhuma chave de IA configurada no servidor." });
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
  }

  const { result: first, model: firstModel } = await callModel({
    apiKey,
    instructions: SYSTEM_PROMPT_JUDGE,
    input: buildUserContent(input, mediaContext),
    timeoutMs,
  });

  // Passo 2 — a IA pediu mais? Baixa áudio + transcreve + rejulga.
  // Vídeo com URL sempre passa pelo passo 2 (transcrição é obrigatória).
  const mustTranscribe =
    wantsMedia && isUrl && (first?.needs_media === true || (input?.kind === "video" && !transcript));
  if (mustTranscribe) {
    try {
      const enriched = await enrichWithMedia(maybeUrl);
      mediaDebug = [...mediaDebug, ...enriched.debug];
      if (enriched.mediaContext && enriched.mediaContext !== mediaContext) {
        mediaContext = enriched.mediaContext;
      }
      if (enriched.origin && !origin) origin = enriched.origin;
      transcript = enriched.transcript;
    } catch {
      mediaDebug.push("enrich-crashed");
    }
    if (transcript || mediaContext) {
      const kindLabel = input?.kind === "video" ? "vídeo/áudio" : "link";
      const { result: second, model: secondModel } = await callModel({
        apiKey,
        instructions: SYSTEM_PROMPT_FINAL,
        input: `Cheque este ${kindLabel}: ${maybeUrl}\n\nDados extraídos (confie nestes dados):\n${mediaContext}`,
        timeoutMs,
      });
      second.sources = await sanitizeSources(second.sources);
      return { result: second, model: secondModel, media: mediaDebug, transcript, origin };
    }
  }

  if (first?.needs_media === true && !transcript) {
    // IA pediu mídia mas não conseguimos extrair nada: veredito honesto.
    return {
      result: {
        verdict: "unproven",
        score: 30,
        summary: `Não consegui acessar o conteúdo (${first.reason ?? "sem dados"}). Cole o texto ou suba o arquivo para checar.`,
        claims: [],
        sources: [],
      },
      model: firstModel,
      media: mediaDebug,
      transcript: null,
      origin,
    };
  }
  first.sources = await sanitizeSources(first.sources);
  return { result: first, model: firstModel, media: mediaDebug, transcript, origin };
}
