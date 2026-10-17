// Coleta própria, sem cookies de terceiros ou leitura de IP no navegador.
// Um identificador aleatório expira em 30 dias; somente seu HMAC vai ao banco.
const VISITOR_KEY = "iev-audience-visitor-v1";
const ATTRIBUTION_KEY = "iev-audience-source-v1";
const sent = new Map();
const pendingClicks = new Map();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCES = new Set(["direct", "whatsapp", "instagram", "facebook", "google", "youtube", "tiktok", "x", "telegram", "other", "internal"]);
let volatileVisitor;
const MAX_AGE = 30 * 86400000;

function allowed() {
  return navigator.doNotTrack !== "1" && !navigator.globalPrivacyControl && location.pathname !== "/admin" && !location.hash.startsWith("#/admin");
}
function visitorId() {
  try {
    const item = JSON.parse(localStorage.getItem(VISITOR_KEY) || "null");
    if (typeof item?.id === "string" && UUID.test(item.id) && Number.isFinite(item.expiresAt) && item.expiresAt > Date.now() && item.expiresAt <= Date.now() + MAX_AGE) return item.id;
    const created = { id: crypto.randomUUID(), expiresAt: Date.now() + MAX_AGE };
    localStorage.setItem(VISITOR_KEY, JSON.stringify(created));
    return created.id;
  } catch { return volatileVisitor ??= crypto.randomUUID(); }
}
function classifySource() {
  const tag = new URLSearchParams(location.search).get("utm_source")?.toLowerCase();
  const tagged = { whatsapp: "whatsapp", wa: "whatsapp", instagram: "instagram", ig: "instagram", facebook: "facebook", fb: "facebook", google: "google", youtube: "youtube", tiktok: "tiktok", twitter: "x", x: "x", telegram: "telegram" };
  if (tag && Object.hasOwn(tagged, tag)) return tagged[tag];
  try {
    const host = new URL(document.referrer).hostname.toLowerCase();
    if (host === location.hostname) return "internal";
    const matches = (domain) => host === domain || host.endsWith(`.${domain}`);
    if (matches("whatsapp.com") || matches("wa.me")) return "whatsapp";
    if (matches("instagram.com")) return "instagram";
    if (matches("facebook.com") || matches("fb.com")) return "facebook";
    if (/(^|\.)google\.[a-z.]+$/.test(host)) return "google";
    if (matches("youtube.com") || matches("youtu.be")) return "youtube";
    if (matches("tiktok.com")) return "tiktok";
    if (matches("x.com") || matches("twitter.com") || matches("t.co")) return "x";
    if (matches("t.me") || matches("telegram.org")) return "telegram";
    return "other";
  } catch { return "direct"; }
}
const source = classifySource();

function send(event, checkId, key, eventSource = source) {
  if (!allowed() || sent.has(key)) return sent.get(key) ?? Promise.resolve(false);
  let body;
  try { body = { eventId: crypto.randomUUID(), visitorId: visitorId(), event, checkId, source: eventSource }; }
  catch { return Promise.resolve(false); }
  // A interface nunca aguarda analytics. Keepalive preserva o evento na navegação.
  const pending = fetch("/api/audience", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive: true })
    .then((response) => response.ok).catch(() => false);
  sent.set(key, pending);
  return pending;
}
export function trackPageView(checkId = null) {
  const record = () => { void send("page_view", checkId, `view:${checkId ?? "home"}`); };
  if (document.visibilityState === "visible") { record(); return () => {}; }
  const onVisible = () => {
    if (document.visibilityState === "visible") { record(); document.removeEventListener("visibilitychange", onVisible); }
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => document.removeEventListener("visibilitychange", onVisible);
}
export function trackNewCheck(checkId) {
  if (!checkId || !allowed()) return;
  try { sessionStorage.setItem(ATTRIBUTION_KEY, JSON.stringify({ checkId, at: Date.now(), source })); } catch { /* Atribuição opcional. */ }
  // Aguarda só em segundo plano a gravação da abertura, evitando corrida no banco.
  if (!pendingClicks.has(checkId)) pendingClicks.set(checkId, Promise.resolve(sent.get(`view:${checkId}`)).then(() => send("new_check", checkId, `cta:${checkId}`)));
}
export function trackCheckCompleted() {
  try {
    const attribution = JSON.parse(sessionStorage.getItem(ATTRIBUTION_KEY) || "null");
    const age = Date.now() - attribution?.at;
    if (!attribution || typeof attribution.checkId !== "string" || !/^[a-z0-9-]{1,100}$/i.test(attribution.checkId) || !Number.isFinite(age) || age < 0 || age > 30 * 60000) {
      sessionStorage.removeItem(ATTRIBUTION_KEY);
      return;
    }
    const attributedSource = SOURCES.has(attribution.source) ? attribution.source : source;
    void Promise.resolve(pendingClicks.get(attribution.checkId) ?? sent.get(`cta:${attribution.checkId}`)).then(() => send("check_completed", attribution.checkId, `conversion:${attribution.checkId}`, attributedSource));
    sessionStorage.removeItem(ATTRIBUTION_KEY);
  } catch { /* Nunca interfere na checagem. */ }
}
