// Núcleo server-side da checagem — compartilhado entre:
// - vite.api-plugin.js (dev local)
// - api/verify.js (serverless Vercel)
// A key OpenCode NUNCA chega ao browser.
import { downloadAudio, fetchMediaContext } from "./media.js";
import { transcribe, transcriptToPrompt } from "./transcribe.js";

export const OPENCODE_URL = "https://opencode.ai/zen/go/v1/responses";
export const DEFAULT_MODEL = "muse-spark-1.3-contributor";

const BASE_RULES = `Regras: separe cada afirmação checável do conteúdo; "context" quando a frase é parcialmente verdadeira mas engana sem contexto; seja cético com prints sem origem e correntes de WhatsApp; cite fontes reais e específicas (TSE, agências de checagem, veículos) com URLs reais quando souber; score geral pondera a gravidade de cada afirmação. Tudo em pt-BR.`;

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

async function callModel({ apiKey, model, instructions, input, timeoutMs }) {
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
        model,
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
      fail(502, code, { message: raw.slice(0, 500), model });
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail(502, "upstream_bad_json", { model });
    }
    return parseModelJson(extractText(parsed), model);
  } catch (err) {
    if (err?.payload) throw err;
    if (err?.name === "AbortError") fail(504, "upstream_timeout", { model });
    fail(502, "upstream_fetch_failed", { model });
  } finally {
    clearTimeout(timeout);
  }
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
  return { mediaContext: mediaContext.trim(), transcript, debug };
}

/**
 * Executa a checagem via OpenCode Go, em até 2 passes:
 * 1. julga com metadados do link (rápido); vídeo sempre ganha transcrição.
 * 2. se a IA pedir mídia (needs_media), baixa + transcreve e rejulga.
 * @returns {{ result: object, model: string, media: string[], transcript: object|null }}
 */
export async function runVerify(input, { apiKey, model, timeoutMs = 120_000 } = {}) {
  if (!apiKey) {
    fail(503, "missing_api_key", { message: "OPENCODE_API não configurada no servidor." });
  }
  const mdl = model || DEFAULT_MODEL;
  const maybeUrl = String(input?.text ?? "").trim();
  const isUrl = /^https?:\/\//.test(maybeUrl);
  const wantsMedia = input?.kind === "link" || input?.kind === "video";

  // Passo 1 — metadados rápidos (yt-dlp probe / oEmbed / OpenGraph).
  let mediaContext = "";
  let transcript = null;
  let mediaDebug = [];
  if (wantsMedia && isUrl) {
    try {
      const media = await fetchMediaContext(maybeUrl);
      mediaDebug = media.attempts;
      if (media.ok) mediaContext = media.context;
    } catch {
      mediaDebug = ["media-kit-crashed"];
    }
  }

  const first = await callModel({
    apiKey,
    model: mdl,
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
      transcript = enriched.transcript;
    } catch {
      mediaDebug.push("enrich-crashed");
    }
    if (transcript || mediaContext) {
      const kindLabel = input?.kind === "video" ? "vídeo/áudio" : "link";
      const second = await callModel({
        apiKey,
        model: mdl,
        instructions: SYSTEM_PROMPT_FINAL,
        input: `Cheque este ${kindLabel}: ${maybeUrl}\n\nDados extraídos (confie nestes dados):\n${mediaContext}`,
        timeoutMs,
      });
      return { result: second, model: mdl, media: mediaDebug, transcript };
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
      model: mdl,
      media: mediaDebug,
      transcript: null,
    };
  }
  return { result: first, model: mdl, media: mediaDebug, transcript };
}
