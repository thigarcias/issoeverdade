// Núcleo server-side da checagem — compartilhado entre:
// - vite.api-plugin.js (dev local)
// - api/verify.js (serverless Vercel)
// A key OpenCode NUNCA chega ao browser.
import { fetchMediaContext } from "./media.js";

export const OPENCODE_URL = "https://opencode.ai/zen/go/v1/responses";
export const DEFAULT_MODEL = "muse-spark-1.3-contributor";

export const SYSTEM_PROMPT = `Você é o verificador de fatos do "isso é verdade?", especializado na política do Brasil, segundo turno das Eleições 2026. Responda ESTRITAMENTE em JSON válido, sem markdown, sem texto fora do JSON, com este formato exato:
{"verdict":"true|mostly_true|mixed|unproven|misleading|false","score":0-100,"summary":"resumo em pt-BR, 1-2 frases","claims":[{"status":"true|false|unproven|context","score":0-100,"text":"a afirmação entre aspas","note":"justificativa curta em pt-BR"}],"sources":[{"outlet":"nome da fonte","detail":"tipo · data","url":"https://..."}]}
Regras: separe cada afirmação checável do conteúdo; "context" quando a frase é parcialmente verdadeira mas engana sem contexto; seja cético com prints sem origem e correntes de WhatsApp; cite fontes reais e específicas (TSE, agências de checagem, veículos) com URLs reais quando souber; score geral pondera a gravidade de cada afirmação. Tudo em pt-BR.`;

export function buildUserContent(input, mediaContext = "") {
  const text = String(input?.text ?? "").slice(0, 8000);
  const fileName = input?.fileName ? String(input.fileName).slice(0, 200) : null;
  if (input?.kind === "link") {
    if (mediaContext) {
      return `Cheque este link: ${text}\n\nConteúdo extraído da página (confie nestes dados, não na URL):\n${mediaContext}`;
    }
    return `Cheque este link (analise a URL e descreva o que se pode inferir dela; se não houver conteúdo acessível, julgue com base no padrão da URL e sinalize a limitação): ${text}`;
  }
  if (input?.kind === "video") {
    const link = /^https?:\/\//.test(text) ? text : "";
    if (link && mediaContext) {
      return `Cheque este vídeo/áudio: ${link}\n\nMetadados extraídos do post (confie nestes dados):\n${mediaContext}\n\nNota: transcrição do áudio ainda indisponível — julgue título, autor, descrição e duração; sinalize o que dependeria do áudio.`;
    }
    return `Cheque este vídeo/áudio${fileName ? ` (arquivo: ${fileName})` : ""}. Como não tenho o áudio, analise a descrição/link: ${text || "(sem descrição — sinalize como sem comprovação)"}. Se for link de rede social, julgue o que for inferível e sinalize limites.`;
  }
  if (input?.kind === "image") {
    return `Cheque esta imagem${fileName ? ` (arquivo: ${fileName})` : ""}. Como não vejo a imagem, analise a descrição: ${text || "(sem descrição — sinalize como sem comprovação)"}.`;
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

/**
 * Executa a checagem via OpenCode Go.
 * @returns {{ result: object, model: string }}
 * @throws Error com `.status` + `.payload` para resposta HTTP de erro.
 */
export async function runVerify(input, { apiKey, model, timeoutMs = 120_000 } = {}) {
  if (!apiKey) {
    fail(503, "missing_api_key", { message: "OPENCODE_API não configurada no servidor." });
  }
  const mdl = model || DEFAULT_MODEL;
  // Links ganham contexto real: baixa metadados do post/vídeo antes de checar.
  let mediaContext = "";
  let mediaDebug = [];
  const maybeUrl = String(input?.text ?? "").trim();
  if ((input?.kind === "link" || input?.kind === "video") && /^https?:\/\//.test(maybeUrl)) {
    try {
      const media = await fetchMediaContext(maybeUrl);
      mediaDebug = media.attempts;
      if (media.ok) mediaContext = media.context;
    } catch {
      mediaDebug = ["media-kit-crashed"];
    }
  }
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
        model: mdl,
        instructions: SYSTEM_PROMPT,
        input: buildUserContent(input, mediaContext),
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
      fail(502, code, { message: raw.slice(0, 500), model: mdl });
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail(502, "upstream_bad_json", { model: mdl });
    }
    const content = extractText(parsed);
    const jsonStart = content.indexOf("{");
    const jsonEnd = content.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd <= jsonStart) {
      fail(502, "model_bad_json", { model: mdl, raw: content.slice(0, 500) });
    }
    try {
      return { result: JSON.parse(content.slice(jsonStart, jsonEnd + 1)), model: mdl, media: mediaDebug };
    } catch {
      fail(502, "model_bad_json", { model: mdl, raw: content.slice(0, 500) });
    }
  } catch (err) {
    if (err?.payload) throw err;
    if (err?.name === "AbortError") fail(504, "upstream_timeout", { model: mdl });
    fail(502, "upstream_fetch_failed", { model: mdl });
  } finally {
    clearTimeout(timeout);
  }
}
