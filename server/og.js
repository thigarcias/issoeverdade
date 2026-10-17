// Pré-visualização de links para crawlers de redes sociais. Pessoas recebem 302 para o SPA.
// Googlebot fica fora de propósito: recebe o 302 como visitante comum e nunca indexa o HTML de OG.
import { VERDICTS } from "../src/data/constants.js";
import { validCheckId } from "./checklog.js";
import { handleChecksRequest } from "./checks-endpoint.js";

const CRAWLER_UA = /\b(Twitterbot|facebookexternalhit|LinkedInBot|Slackbot|TelegramBot|WhatsApp|Discordbot)\b/i;
const UTM_KEY = /^utm_(source|medium|campaign|content|term)$/;
const SITE_NAME = "isso é verdade?";
const FALLBACK_DESCRIPTION = "Verificador automático de afirmações públicas no Brasil, com fontes e limites explícitos.";
const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex" };

export function isCrawler(userAgent) {
  return CRAWLER_UA.test(String(userAgent ?? ""));
}

export function truncate(text, max) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

export function ogTitle(result) {
  const title = truncate(String(result?.title ?? "").replace(/^Checagem:\s*/i, ""), 90);
  return title ? `${title} · ${SITE_NAME}` : SITE_NAME;
}

export function ogDescription(result) {
  const verdict = Object.hasOwn(VERDICTS, result?.verdict) ? VERDICTS[result.verdict].label : null;
  const score = Number.isFinite(result?.score) ? `Nota ${result.score}/100` : null;
  const head = [verdict, score].filter(Boolean).join(" · ");
  const summary = truncate(result?.summary, 200);
  return truncate([head, summary].filter(Boolean).join(". "), 200) || FALLBACK_DESCRIPTION;
}

// Host vem do cabeçalho do cliente: só aceita forma de hostname[:porta], senão omite og:url.
export function siteOrigin(headers = {}) {
  const host = String(headers["x-forwarded-host"] ?? headers.host ?? "").split(",")[0].trim();
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host)) return null;
  const scheme = /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https";
  return `${scheme}://${host}`;
}

export function ogHtml({ url, title, description, image }) {
  const t = escapeHtml(title);
  const d = escapeHtml(description);
  const u = url ? escapeHtml(url) : null;
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="robots" content="noindex" />
<title>${t}</title>
<meta name="description" content="${d}" />
<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}" />
<meta property="og:type" content="article" />
<meta property="og:title" content="${t}" />
<meta property="og:description" content="${d}" />
${image ? `<meta property="og:image" content="${escapeHtml(image)}" />\n<meta name="twitter:image" content="${escapeHtml(image)}" />\n` : ""}${u ? `<meta property="og:url" content="${u}" />\n` : ""}<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}" />
<meta name="twitter:title" content="${t}" />
<meta name="twitter:description" content="${d}" />
</head>
<body>${u ? `<p><a href="${u}">Ver a checagem</a></p>` : `<p><a href="/">${escapeHtml(SITE_NAME)}</a></p>`}</body>
</html>
`;
}

const fallbackPage = (origin) => ({
  status: 200,
  headers: { ...HTML_HEADERS, "Cache-Control": "no-store" },
  html: ogHtml({ url: null, title: SITE_NAME, description: FALLBACK_DESCRIPTION, image: origin ? `${origin}/og-default.png` : null }),
});

/**
 * Entrada de /check/:id. Retorna { status, headers, body }; body é null em 302 e HEAD.
 * `fetchCheck` é a fronteira com o endpoint público (rate limit + projeção); injetável só para teste.
 */
export async function handleOg({ method, headers = {}, query = {}, socketAddress, env = process.env, fetchCheck = handleChecksRequest } = {}) {
  const common = { Vary: "User-Agent", "X-Content-Type-Options": "nosniff" };
  if (method !== "GET" && method !== "HEAD") {
    return { status: 405, headers: { ...common, Allow: "GET, HEAD", "Cache-Control": "no-store" }, body: null };
  }
  const id = typeof query.id === "string" ? query.id : "";
  const validId = validCheckId(id);

  if (!isCrawler(headers["user-agent"])) {
    const utm = Object.entries(query)
      .filter(([key, value]) => UTM_KEY.test(key) && typeof value === "string")
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    const location = validId
      ? `/?check=${encodeURIComponent(id)}${utm.length ? `&${utm.join("&")}` : ""}`
      : "/";
    return { status: 302, headers: { ...common, Location: location, "Cache-Control": "private, no-store" }, body: null };
  }

  const page = await crawlerPage({ id, validId, headers, socketAddress, env, fetchCheck });
  return {
    status: page.status,
    headers: { ...common, ...page.headers },
    body: method === "HEAD" ? null : page.html,
  };
}

async function crawlerPage({ id, validId, headers, socketAddress, env, fetchCheck }) {
  const origin = siteOrigin(headers);
  if (!validId) return fallbackPage(origin);
  let out;
  try {
    out = await fetchCheck({ method: "GET", headers, query: { id }, socketAddress, env });
  } catch {
    return fallbackPage(origin);
  }
  // Fail-open: sem checagem publicada (404), limite (429) ou erro de storage, o crawler recebe a página genérica.
  if (out?.status !== 200 || !out.body?.result) return fallbackPage(origin);
  const url = origin ? `${origin}/check/${encodeURIComponent(id)}` : null;
  return {
    status: 200,
    headers: { ...HTML_HEADERS, "Cache-Control": "no-store" },
    html: ogHtml({ url, title: ogTitle(out.body.result), description: ogDescription(out.body.result), image: origin ? `${origin}/api/og-image?id=${encodeURIComponent(id)}` : null }),
  };
}
