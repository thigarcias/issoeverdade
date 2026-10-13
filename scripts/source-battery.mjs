#!/usr/bin/env node
// Bateria de fontes: exercita leitura de URLs variadas sem chamar IA paga.
// Camadas: parseUrlStrict/isArticleUrl + fetchMediaContext + probeOEmbed +
// probeOpenGraph + fetchDocument/extractDocumentText + normalizeVerifyInput.
// Uso: node scripts/source-battery.mjs [--quick] [--out tmp-dl/source-battery.json]
import { writeFile, mkdir } from "node:fs/promises";

const QUICK = process.argv.includes("--quick");
const outIdx = process.argv.indexOf("--out");
const OUT = outIdx >= 0 ? process.argv[outIdx + 1] : "tmp-dl/source-battery.json";

const media = await import("../server/media.js");
const net = await import("../server/net.js");
const evidence = await import("../server/evidence.js");
const uploads = await import("../server/uploads.js");

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
  "news-wiki", "news-govbr", "soc-x", "soc-youtube", "soc-tiktok", "soc-instagram",
  "file-pdf", "http-404", "http-500", "block-localhost", "block-metadata", "block-port",
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

async function runCase(item) {
  const out = { id: item.id, grupo: item.grupo, url: item.url, espera: item.espera, steps: {}, msTotal: 0 };
  const t0 = Date.now();
  // 1. policy
  try {
    const parsed = net.parseUrlStrict(item.url);
    out.steps.policy = { ok: true, host: parsed.host, port: parsed.port };
  } catch (e) {
    out.steps.policy = { ok: false, code: e?.code ?? String(e?.message ?? e) };
  }
  // 2. roteamento
  try {
    out.steps.isArticle = { ok: true, value: media.isArticleUrl(item.url) };
  } catch (e) {
    out.steps.isArticle = { ok: false, threw: String(e?.message ?? e).slice(0, 160) };
  }
  // 3. fetchMediaContext (núcleo da leitura de links)
  try {
    const r = await withTimeout(media.fetchMediaContext(item.url), 75_000, "fetchMediaContext");
    out.steps.fetch = {
      ok: r.ok, attempts: r.attempts ?? [], reason: r.reason ?? null,
      extraction: r.media?.extraction ?? null, method: r.media?.extractionMethod ?? null,
      truncated: r.media?.truncated ?? null, platform: r.media?.platform ?? null,
      source: r.media?.source ?? null, titleLen: r.media?.title?.length ?? 0,
      descLen: r.media?.description?.length ?? 0, bodyLen: r.media?.body?.length ?? 0,
      ctxLen: r.context?.length ?? 0, finalUrl: r.media?.finalUrl ?? null,
    };
  } catch (e) {
    out.steps.fetch = { ok: false, threw: `${e?.code ?? ""} ${String(e?.message ?? e).slice(0, 200)}`.trim() };
  }
  // 4. oEmbed direto
  try {
    const r = await withTimeout(media.probeOEmbed(item.url), 30_000, "oembed");
    out.steps.oembed = { ok: r.ok, reason: r.reason ?? null, platform: r.platform ?? null, textLen: (r.postText ?? r.description ?? "").length };
  } catch (e) {
    out.steps.oembed = { ok: false, threw: String(e?.message ?? e).slice(0, 160) };
  }
  // 5. openGraph direto
  try {
    const r = await withTimeout(media.probeOpenGraph(item.url), 30_000, "opengraph");
    out.steps.opengraph = { ok: r.ok, reason: r.reason ?? null, titleLen: r.title?.length ?? 0, descLen: r.description?.length ?? 0 };
  } catch (e) {
    out.steps.opengraph = { ok: false, threw: String(e?.message ?? e).slice(0, 160) };
  }
  // 6. evidence fetchDocument
  try {
    const r = await withTimeout(evidence.fetchDocument(item.url), 40_000, "fetchDocument");
    out.steps.document = { ok: r.ok, reason: r.reason ?? null, kind: r.kind ?? null, bytes: r.bytes ?? 0, textLen: r.text?.length ?? 0, status: r.status ?? null, truncated: r.truncated ?? false };
  } catch (e) {
    out.steps.document = { ok: false, threw: String(e?.message ?? e).slice(0, 160) };
  }
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
      results.push({ id: c.id, ok: true, mime: norm.fileMime, bytes: norm.fileBuffer?.length ?? 0, esperaOk: c.esperaOk });
    } catch (e) {
      results.push({ id: c.id, ok: false, error: e?.message ?? String(e), status: e?.status ?? null, esperaOk: c.esperaOk });
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
  console.log(`[${i + 1}/${selected.length}] ${r.id} policy=${r.steps.policy.ok ? "ok" : r.steps.policy.code} article=${r.steps.isArticle.value} fetch=${f.ok ? "OK" : "FAIL"}[${(f.attempts ?? []).join(",") || f.reason || f.threw || "?"}] doc=${r.steps.document.ok ? r.steps.document.kind : r.steps.document.reason} ${r.msTotal}ms`);
}
const uploadResults = await runUploadCases();
for (const u of uploadResults) console.log(`[upload] ${u.id} => ${u.ok ? "aceito" : "recusado:" + u.error} (esperado ${u.esperaOk ? "aceito" : "recusado"})`);

await mkdir(OUT.split("/").slice(0, -1).join("/") || ".", { recursive: true }).catch(() => {});
await writeFile(OUT, JSON.stringify({ at: new Date().toISOString(), quick: QUICK, urls: urlResults, uploads: uploadResults }, null, 2));
console.log(`Relatório JSON: ${OUT}`);
