#!/usr/bin/env node
// Bateria de fontes: exercita classificação, extração e controles sem IA paga.
// Rede real mede compatibilidade observada; fixtures determinísticas ficam nas suítes.
// Uso: node scripts/source-battery.mjs [--quick] [--out tmp-dl/source-battery.json]
import { mkdir, rm, stat, writeFile } from "node:fs/promises";

const QUICK = process.argv.includes("--quick");
const outIdx = process.argv.indexOf("--out");
const OUT = outIdx >= 0 ? process.argv[outIdx + 1] : "tmp-dl/source-battery.json";

const media = await import("../server/media.js");
const net = await import("../server/net.js");
const evidence = await import("../server/evidence.js");
const uploads = await import("../server/uploads.js");
const localMedia = await import("../server/local-media.js");
// ---------------------------------------------------------------------------
// Casos: cada item {id, grupo, url|input, espera}
// espera.ok: true/false/"qualquer" — só documentação; o relatório mostra real.
// ---------------------------------------------------------------------------
const CASES = [
  // Notícias BR (HTML real, paywall potencial, JS pesado)
  { id: "news-g1", grupo: "noticia-br", url: "https://g1.globo.com/", espera: "qualquer" },
  { id: "news-uol", grupo: "noticia-br", url: "https://www.uol.com.br/", espera: "qualquer" },
  { id: "news-folha", grupo: "noticia-br", url: "https://www.folha.uol.com.br/", espera: "qualquer" },
  { id: "news-estadao", grupo: "noticia-br", url: "https://www.estadao.com.br/", espera: "qualquer" },
  { id: "news-oglobo", grupo: "noticia-br", url: "https://oglobo.globo.com/", espera: "qualquer" },
  { id: "news-bbc-brasil", grupo: "noticia-br", url: "https://www.bbc.com/portuguese", espera: "qualquer" },
  { id: "news-agencia-brasil", grupo: "noticia-br", url: "https://agenciabrasil.ebc.com.br/", espera: "qualquer" },
  { id: "news-poder360", grupo: "noticia-br", url: "https://www.poder360.com.br/", espera: "qualquer" },
  { id: "news-article-agenciabrasil", grupo: "artigo-concreto", url: "https://agenciabrasil.ebc.com.br/politica/noticia/2026-10/eleicoes-2026-acompanhe-apuracao-em-tempo-real-pela-agencia-brasil", espera: "qualquer" },
  // Internacional / estruturado
  { id: "news-bbc-world", grupo: "noticia-intl", url: "https://www.bbc.com/news", espera: "qualquer" },
  { id: "news-reuters", grupo: "noticia-intl", url: "https://www.reuters.com/", espera: "qualquer" },
  { id: "news-ap", grupo: "noticia-intl", url: "https://apnews.com/", espera: "qualquer" },
  { id: "news-wiki", grupo: "enciclopedia", url: "https://pt.wikipedia.org/wiki/Brasil", espera: true },
  { id: "news-govbr", grupo: "oficial", url: "https://www.gov.br/pt-br", espera: "qualquer" },
  { id: "news-ibge", grupo: "oficial", url: "https://www.ibge.gov.br/", espera: "qualquer" },
  { id: "news-senado", grupo: "oficial", url: "https://www12.senado.leg.br/noticias/", espera: "qualquer" },
  // Blogs/newsletters/plataformas de texto
  { id: "blog-medium", grupo: "blog", url: "https://medium.com/", espera: "qualquer" },
  { id: "blog-substack", grupo: "blog", url: "https://substack.com/", espera: "qualquer" },
  // Shorteners / redirects
  { id: "redir-bitly", grupo: "redirect", url: "https://bit.ly/3test", espera: "qualquer" },
  { id: "redir-tco", grupo: "redirect", url: "https://t.co/KEAPaHx3vu", espera: "qualquer" },
  { id: "redir-utm", grupo: "redirect", url: "https://pt.wikipedia.org/wiki/Brasil?utm_source=x&utm_medium=social", espera: true },
  { id: "redir-http", grupo: "redirect", url: "http://example.com/", espera: "qualquer" },
  // Social — oEmbed/metadados
  { id: "soc-x", grupo: "social", url: "https://x.com/folha/status/2110064007184842779", espera: "qualquer" },
  { id: "soc-twitter", grupo: "social", url: "https://twitter.com/g1/status/1", espera: "qualquer" },
  { id: "soc-youtube", grupo: "social-video", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", espera: "qualquer" },
  { id: "soc-youtu-be", grupo: "social-video", url: "https://youtu.be/dQw4w9WgXcQ", espera: "qualquer" },
  { id: "soc-tiktok", grupo: "social-video", url: "https://www.tiktok.com/@tiktok/video/7106594312292453675", espera: "qualquer" },
  { id: "soc-instagram", grupo: "social-video", url: "https://www.instagram.com/p/C0test123/", espera: "qualquer" },
  { id: "soc-facebook", grupo: "social-video", url: "https://www.facebook.com/watch/?v=101111111111111", espera: "qualquer" },
  { id: "soc-threads", grupo: "social", url: "https://www.threads.com/@instagram/post/C0test", espera: "qualquer" },
  { id: "soc-reddit", grupo: "social", url: "https://www.reddit.com/r/brasil/", espera: "qualquer" },
  { id: "soc-linkedin", grupo: "social", url: "https://www.linkedin.com/", espera: "qualquer" },
  { id: "soc-kwai", grupo: "social-video", url: "https://www.kwai.com/", espera: "qualquer" },
  { id: "soc-vimeo", grupo: "social-video", url: "https://vimeo.com/123456", espera: "qualquer" },
  { id: "soc-twitch", grupo: "social-video", url: "https://www.twitch.tv/videos/123456", espera: "qualquer" },
  { id: "soc-spotify", grupo: "audio", url: "https://open.spotify.com/episode/abc123", espera: "qualquer" },
  // Arquivos diretos
  { id: "file-pdf", grupo: "arquivo", url: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf", espera: "qualquer" },
  { id: "file-img", grupo: "arquivo", url: "https://httpbin.org/image/png", espera: "qualquer" },
  { id: "file-mp4", grupo: "arquivo", url: "https://download.samplelib.com/mp4/sample-5s.mp4", espera: "qualquer" },
  // HTTP statuses / borda
  { id: "http-404", grupo: "http-status", url: "https://httpbin.org/status/404", espera: false },
  { id: "http-500", grupo: "http-status", url: "https://httpbin.org/status/500", espera: false },
  { id: "http-403", grupo: "http-status", url: "https://httpbin.org/status/403", espera: false },
  { id: "http-delay", grupo: "http-status", url: "https://httpbin.org/delay/25", espera: false },
  { id: "http-big", grupo: "http-status", url: "https://httpbin.org/bytes/20000000", espera: "qualquer" },
  { id: "http-redir-chain", grupo: "redirect", url: "https://httpbin.org/redirect/5", espera: "qualquer" },
  { id: "http-rel-redir", grupo: "redirect", url: "https://httpbin.org/relative-redirect/2", espera: "qualquer" },
  // Bloqueados pela política (devem falhar com motivo estável, sem exceção)
  { id: "block-localhost", grupo: "bloqueio", url: "http://localhost:3000/teste", espera: false },
  { id: "block-loopback", grupo: "bloqueio", url: "http://127.0.0.1/", espera: false },
  { id: "block-metadata", grupo: "bloqueio", url: "http://169.254.169.254/latest/meta-data/", espera: false },
  { id: "block-private10", grupo: "bloqueio", url: "http://10.0.0.1/", espera: false },
  { id: "block-port", grupo: "bloqueio", url: "https://example.com:8080/teste", espera: false },
  { id: "block-creds", grupo: "bloqueio", url: "https://user:pass@example.com/", espera: false },
  { id: "block-ftp", grupo: "bloqueio", url: "ftp://example.com/file", espera: false },
  { id: "block-nohost", grupo: "bloqueio", url: "not-a-url", espera: false },
  { id: "block-empty", grupo: "bloqueio", url: "", espera: false },
  { id: "block-ipv6-loop", grupo: "bloqueio", url: "http://[::1]/", espera: false },
  { id: "block-single-label", grupo: "bloqueio", url: "http://meuintranet/", espera: false },
  // Encoding / unicode / borda de URL
  { id: "enc-espaco", grupo: "url-borda", url: "https://pt.wikipedia.org/wiki/São Paulo", espera: "qualquer" },
  { id: "enc-query", grupo: "url-borda", url: "https://example.com/busca?q=eleição 2026&lang=pt-BR", espera: "qualquer" },
  { id: "enc-fragment", grupo: "url-borda", url: "https://pt.wikipedia.org/wiki/Brasil#História", espera: true },
  { id: "enc-maiusculas", grupo: "url-borda", url: "HTTPS://PT.WIKIPEDIA.ORG/wiki/Brasil", espera: true },
  { id: "enc-trim", grupo: "url-borda", url: "   https://pt.wikipedia.org/wiki/Brasil   ", espera: true },
  { id: "enc-idn", grupo: "url-borda", url: "https://pt.wikipedia.org/wiki/Ética", espera: "qualquer" },
];

const QUICK_IDS = new Set([
  "news-wiki", "news-govbr", "news-article-agenciabrasil", "soc-x", "soc-youtube", "soc-tiktok", "soc-instagram",
  "file-pdf", "file-img", "file-mp4", "http-404", "http-500", "block-localhost", "block-metadata", "block-port",
  "block-ftp", "block-nohost", "enc-espaco", "enc-fragment", "redir-utm",
]);

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout:${label}:${ms}ms`)), ms);
  });
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    timeout,
  ]);
}

function expectedModality(item) {
  if (item.grupo === "bloqueio") return "policy-rejection";
  if (item.id === "file-pdf") return "PDF document";
  if (item.id === "file-img") return "image";
  if (item.id === "file-mp4") return "video";
  if (item.id === "soc-spotify") return "audio episode";
  if (item.grupo === "social-video") return "social post with possible video";
  if (item.grupo === "social") return "social post; media depends on attachment";
  if (item.grupo === "artigo-concreto") return "concrete HTML article";
  if (["noticia-br", "noticia-intl", "enciclopedia", "oficial", "blog"].includes(item.grupo)) return "HTML page/homepage; not proof of full article coverage";
  if (item.grupo === "http-status") return "HTTP response";
  if (item.grupo === "redirect") return "redirect target; modality resolved at final URL";
  if (item.grupo === "url-borda") return "URL normalization then final resource modality";
  return "modality resolved from final URL and MIME";
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

async function runMediaExtraction(url, sourceInfo) {
  const limits = media.mediaLimits();
  const acquired = await withTimeout(
    media.downloadMedia(url, "./tmp-dl/source-battery-media", sourceInfo.type),
    limits.workerTimeoutMs + 15_000,
    "media-extraction",
  ).catch((error) => {
    const reason = error?.message?.split(":")[0] ?? "media-timeout";
    return { ok: false, audio: { ok: false, reason }, frameResult: { ok: false, reason }, attempts: [] };
  });
  const { audio: audioResult, frameResult } = acquired;
  let audio;
  try {
    if (!audioResult.ok || !audioResult.file) {
      audio = { ok: false, reason: audioResult.reason ?? "audio-artifact-unavailable", via: audioResult.via ?? null };
    } else {
      const inspection = await localMedia.inspectMediaFile(audioResult.file, limits.maxMediaSeconds);
      const bytes = (await stat(audioResult.file)).size;
      audio = {
        ok: inspection.ok && inspection.hasAudio && bytes > 0,
        reason: inspection.ok && inspection.hasAudio && bytes > 0 ? null : inspection.reason ?? "audio-content-unreadable",
        via: audioResult.via ?? null,
        durationSec: inspection.durationSec ?? audioResult.durationSec ?? null,
        bytes,
      };
    }
  } catch (error) {
    audio = { ok: false, reason: error?.code ?? "audio-validation-failed", via: audioResult.via ?? null };
  } finally {
    if (audioResult.dir) await rm(audioResult.dir, { recursive: true, force: true }).catch(() => {});
  }

  if (sourceInfo.type === "audio") return { applicable: true, audio: { ...audio, applicable: true }, frames: { applicable: false, reason: "audio-only-source" }, attempts: acquired.attempts ?? [] };
  const frames = media.normalizeWorkerFrames(frameResult.frames);
  const framesBytes = frames.reduce((sum, frame) => sum + Buffer.from(frame.data, "base64").length, 0);
  return {
    applicable: true,
    audio: { ...audio, applicable: true },
    frames: {
      applicable: true,
      ok: Boolean(frameResult.ok && frames.length && frames.length === (frameResult.frames?.length ?? 0)),
      reason: frameResult.ok && frames.length ? null : frameResult.reason ?? "no-readable-frames",
      via: frameResult.via ?? null,
      count: frames.length,
      bytes: framesBytes,
      durationSec: frameResult.seconds ?? null,
    },
    attempts: acquired.attempts ?? [],
  };
}

async function runCase(item) {
  const out = {
    id: item.id,
    grupo: item.grupo,
    url: safeUrl(item.url),
    espera: item.espera,
    expectedModality: expectedModality(item),
    steps: {},
    limitation: null,
    msTotal: 0,
  };
  const t0 = Date.now();
  try {
    const parsed = net.parseUrlStrict(item.url);
    out.steps.policy = { ok: true, host: parsed.host, port: parsed.port };
  } catch (error) {
    out.steps.policy = { ok: false, code: error?.code ?? "invalid_url" };
    out.steps.routing = { applicable: false, reason: "invalid-input" };
    out.steps.fetch = { applicable: false, reason: "invalid-input" };
    out.steps.document = { applicable: false, reason: "invalid-input" };
    out.steps.extraction = { applicable: false, reason: "invalid-input" };
    out.limitation = out.steps.policy.code;
    out.msTotal = Date.now() - t0;
    return out;
  }

  let sourceInfo;
  try {
    sourceInfo = await withTimeout(media.resolveSourceType(item.url), 15_000, "source-classification");
    out.steps.routing = {
      ok: true,
      expected: out.expectedModality,
      type: sourceInfo.type,
      mediaCandidate: Boolean(sourceInfo.mediaCandidate),
      social: Boolean(sourceInfo.social),
      finalUrl: safeUrl(sourceInfo.finalUrl),
    };
  } catch (error) {
    out.steps.routing = { ok: false, expected: out.expectedModality, reason: error?.code ?? "classification-failed" };
    out.steps.fetch = { applicable: false, reason: "classification-failed" };
    out.steps.document = { applicable: false, reason: "classification-failed" };
    out.steps.extraction = { applicable: false, reason: "classification-failed" };
    out.limitation = "classification-failed";
    out.msTotal = Date.now() - t0;
    return out;
  }

  let fetched = null;
  try {
    fetched = await withTimeout(media.fetchMediaContext(item.url, { sourceInfo }), 75_000, "fetchMediaContext");
    out.steps.fetch = {
      ok: fetched.ok,
      attempts: fetched.attempts ?? [],
      reason: fetched.reason ?? null,
      extraction: fetched.media?.extraction ?? null,
      method: fetched.media?.extractionMethod ?? null,
      truncated: fetched.media?.truncated ?? null,
      platform: fetched.media?.platform ?? null,
      source: fetched.media?.source ?? null,
      titleLen: fetched.media?.title?.length ?? 0,
      descLen: fetched.media?.description?.length ?? 0,
      bodyLen: fetched.media?.body?.length ?? 0,
      postTextLen: fetched.media?.postText?.length ?? 0,
      linkedContextLen: fetched.media?.linkedContext?.length ?? 0,
      ctxLen: fetched.context?.length ?? 0,
      finalUrl: safeUrl(fetched.media?.finalUrl ?? sourceInfo.finalUrl),
    };
  } catch (error) {
    out.steps.fetch = { ok: false, reason: error?.code ?? "fetch-failed" };
  }

  if (sourceInfo.type === "pdf") {
    out.steps.document = {
      applicable: true,
      ok: Boolean(fetched?.ok),
      kind: "pdf",
      extraction: fetched?.media?.extraction ?? "inaccessible",
      method: fetched?.media?.extractionMethod ?? "unpdf",
      textLen: fetched?.media?.body?.length ?? 0,
      reason: fetched?.reason ?? null,
    };
  } else if (sourceInfo.type === "html") {
    try {
      const document = await withTimeout(evidence.fetchDocument(item.url), 40_000, "fetchDocument");
      out.steps.document = { applicable: true, ok: document.ok, kind: document.kind ?? null, bytes: document.bytes ?? 0, textLen: document.text?.length ?? 0, status: document.status ?? null, truncated: document.truncated ?? false, reason: document.reason ?? null };
    } catch (error) {
      out.steps.document = { applicable: true, ok: false, reason: error?.code ?? "document-failed" };
    }
  } else {
    out.steps.document = { applicable: false, reason: `not-document:${sourceInfo.type}` };
  }

  if (sourceInfo.type === "image") {
    try {
      const image = await withTimeout(media.fetchImageSource(sourceInfo.finalUrl ?? item.url), 25_000, "image-fetch");
      out.steps.image = {
        applicable: true,
        ok: image.ok,
        reason: image.reason ?? null,
        mime: image.fileMime ?? null,
        bytes: image.fileBuffer?.length ?? 0,
        finalUrl: safeUrl(image.finalUrl),
      };
    } catch (error) {
      out.steps.image = { applicable: true, ok: false, reason: error?.code ?? "image-fetch-failed" };
    }
  } else {
    out.steps.image = { applicable: false, reason: `not-image:${sourceInfo.type}` };
  }

  if (["audio", "video"].includes(sourceInfo.type) || sourceInfo.mediaCandidate) {
    out.steps.extraction = await runMediaExtraction(sourceInfo.finalUrl ?? item.url, sourceInfo);
  } else {
    out.steps.extraction = { applicable: false, reason: "no-audiovisual-candidate" };
  }
  const limitations = [];
  if (fetched?.reason && !["image", "audio", "video"].includes(sourceInfo.type)) limitations.push(`fetch:${fetched.reason}`);
  if (out.steps.image?.applicable && !out.steps.image.ok) limitations.push(`image:${out.steps.image.reason}`);
  if (out.steps.extraction?.audio && !out.steps.extraction.audio.ok) limitations.push(`audio:${out.steps.extraction.audio.reason}`);
  if (out.steps.extraction?.frames?.applicable && !out.steps.extraction.frames.ok) limitations.push(`frames:${out.steps.extraction.frames.reason}`);
  if (out.steps.document?.applicable && !out.steps.document.ok) limitations.push(`document:${out.steps.document.reason ?? out.steps.document.extraction}`);
  out.limitation = limitations.length ? limitations.join("; ").slice(0, 300) : null;
  out.msTotal = Date.now() - t0;
  return out;
}

async function runUploadCases() {
  const results = [];
  const png1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const cases = [
    { id: "up-png-ok", input: { kind: "image", text: "", fileData: png1x1.toString("base64"), fileMime: "image/png", fileName: "t.png" }, esperaOk: true },
    { id: "up-jpeg-declara-png", input: { kind: "image", text: "", fileData: png1x1.toString("base64"), fileMime: "image/jpeg", fileName: "t.png" }, esperaOk: false },
    { id: "up-base64-invalido", input: { kind: "image", text: "", fileData: "!!!not-base64!!!", fileMime: "image/png" }, esperaOk: false },
    { id: "up-texto-com-arquivo", input: { kind: "text", text: "oi", fileData: png1x1.toString("base64"), fileMime: "image/png" }, esperaOk: false },
    { id: "up-video-com-png", input: { kind: "video", text: "", fileData: png1x1.toString("base64"), fileMime: "image/png" }, esperaOk: false },
    { id: "up-imagem-com-mp4-fake", input: { kind: "image", text: "", fileData: Buffer.from("ftyp-fake-mp4-conteudo-falso-para-teste-1234567890").toString("base64"), fileMime: "video/mp4" }, esperaOk: false },
    { id: "up-texto-grande", input: { kind: "text", text: "x".repeat(9000) }, esperaOk: false },
    { id: "up-kind-invalido", input: { kind: "pdf", text: "x" }, esperaOk: false },
  ];
  for (const c of cases) {
    try {
      const norm = uploads.normalizeVerifyInput(c.input);
      results.push({ id: c.id, ok: true, expectedModality: c.input.kind, extraction: "upload-validation", path: "normalizeVerifyInput", mime: norm.fileMime, bytes: norm.fileBuffer?.length ?? 0, esperaOk: c.esperaOk });
    } catch (e) {
      results.push({ id: c.id, ok: false, expectedModality: c.input.kind, extraction: "upload-validation", path: "normalizeVerifyInput", error: e?.message ?? String(e), status: e?.status ?? null, esperaOk: c.esperaOk });
    }
  }
  return results;
}

const selected = QUICK ? CASES.filter((c) => QUICK_IDS.has(c.id)) : CASES;
console.log(`Bateria: ${selected.length} casos de URL + uploads (${QUICK ? "quick" : "full"})`);
console.log(`yt-dlp: ${await media.hasYtDlp()}`);
const urlResults = [];
for (const [i, item] of selected.entries()) {
  const r = await runCase(item);
  urlResults.push(r);
  const f = r.steps.fetch;
  const extraction = r.steps.extraction;
  const paths = [...(f?.attempts ?? []), ...(extraction?.attempts ?? [])].join(",") || "n/a";
  const coverage = extraction?.audio?.applicable === false
    ? `audio=${extraction.audio.reason}`
    : `audio=${extraction?.audio?.ok ? "ok" : extraction?.audio?.reason ?? "n/a"} frames=${extraction?.frames?.applicable ? extraction.frames.ok ? "ok" : extraction.frames.reason : "n/a"}`;
  console.log(`[${i + 1}/${selected.length}] ${r.id} expected=${r.expectedModality} type=${r.steps.routing?.type ?? "unresolved"} fetch=${f?.ok ? "OK" : f?.reason ?? "n/a"} coverage=${coverage} paths=[${paths}] limitation=${r.limitation ?? "none"} ${r.msTotal}ms`);
}
const uploadResults = await runUploadCases();
for (const u of uploadResults) console.log(`[upload] ${u.id} => ${u.ok ? "aceito" : "recusado:" + u.error} (esperado ${u.esperaOk ? "aceito" : "recusado"})`);

await mkdir(OUT.split("/").slice(0, -1).join("/") || ".", { recursive: true }).catch(() => {});
await writeFile(OUT, JSON.stringify({ at: new Date().toISOString(), quick: QUICK, urls: urlResults, uploads: uploadResults }, null, 2));
console.log(`Relatório JSON: ${OUT}`);
