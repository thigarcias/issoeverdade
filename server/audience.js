// Audiência própria: nenhum IP, URL completa de referência ou segredo é gravado.
import { createHmac } from "node:crypto";
import { supabaseConfigured, supabaseRequest, reportStorageError } from "./supabase.js";
import { activeGuard } from "./limits.js";
import { clientIp } from "./client-ip.js";
import { validCheckId } from "./checklog.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BOT = /bot\b|crawler|spider|slurp|facebookexternalhit|facebot|telegrambot|twitterbot|linkedinbot|discordbot|slackbot|pinterestbot|headless|lighthouse|pagespeed|preview|prerender|curl\/|wget\/|python-requests|google-inspectiontool/i;
const SOURCES = new Set(["direct", "whatsapp", "instagram", "facebook", "google", "youtube", "tiktok", "x", "telegram", "other", "internal"]);
const REGIONS = {
  AC: "Norte", AP: "Norte", AM: "Norte", PA: "Norte", RO: "Norte", RR: "Norte", TO: "Norte",
  AL: "Nordeste", BA: "Nordeste", CE: "Nordeste", MA: "Nordeste", PB: "Nordeste", PE: "Nordeste", PI: "Nordeste", RN: "Nordeste", SE: "Nordeste",
  DF: "Centro-Oeste", GO: "Centro-Oeste", MT: "Centro-Oeste", MS: "Centro-Oeste",
  ES: "Sudeste", MG: "Sudeste", RJ: "Sudeste", SP: "Sudeste", PR: "Sul", RS: "Sul", SC: "Sul",
};

export function audienceGeo(headers, env = process.env) {
  // Somente cabeçalhos adicionados pela hospedagem; nunca coordenadas do cliente.
  if (env.VERCEL !== "1") return { country: null, state: null, region: null };
  const rawCountry = String(headers["x-vercel-ip-country"] ?? "").toUpperCase();
  const country = /^[A-Z]{2}$/.test(rawCountry) ? rawCountry : null;
  const uf = String(headers["x-vercel-ip-country-region"] ?? "").toUpperCase().replace(/^BR-/, "");
  const state = country === "BR" && Object.hasOwn(REGIONS, uf) ? uf : null;
  return { country, state, region: state ? REGIONS[state] : null };
}

function sameOrigin(headers) {
  if (headers["sec-fetch-site"] === "cross-site") return false;
  if (!headers.origin) return true; // clientes sem Origin continuam sujeitos a validação/taxa.
  try { return new URL(headers.origin).host === String(headers.host ?? ""); }
  catch { return false; }
}

export async function handleAudienceRequest({ method, headers = {}, body = null, socketAddress, env = process.env, guard = activeGuard(env) } = {}) {
  const reply = (status = 204, error) => ({ status, body: error ? { error } : null, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  if (method !== "POST") return reply(405, "method_not_allowed");
  if (!sameOrigin(headers)) return reply(403, "origin_denied");
  if (env.IEV_AUDIENCE_ENABLED === "0" || !supabaseConfigured(env)) return reply();
  const ua = String(headers["user-agent"] ?? "");
  const whatsappPreview = /whatsapp/i.test(ua) && !/mozilla|applewebkit/i.test(ua);
  if (headers.dnt === "1" || headers["sec-gpc"] === "1" || !headers["user-agent"] || BOT.test(ua) || whatsappPreview || /prefetch|prerender/i.test(String(headers.purpose ?? headers["sec-purpose"] ?? ""))) return reply();
  const { eventId, visitorId, event, checkId = null } = body ?? {};
  if (!UUID.test(String(eventId ?? "")) || !UUID.test(String(visitorId ?? "")) || !["page_view", "new_check", "check_completed"].includes(event) || (checkId !== null && !validCheckId(checkId)) || (event !== "page_view" && !checkId)) return reply(400, "invalid_event");
  // O limite é separado do orçamento de IA. Falhas de tracking nunca bloqueiam o site.
  try {
    const rate = await guard.rateLimit(clientIp(headers, socketAddress, env), { bucket: "audience", max: 120, windowSec: 600 });
    if (!rate.allowed) return reply(429, "rate_limited");
    const secret = env.IEV_ANALYTICS_SECRET || env.ADMIN_SECRET || env.SUPABASE_SERVICE_ROLE_KEY;
    if (!secret) return reply();
    const visitor = createHmac("sha256", secret).update(`audience-v1:${visitorId}`).digest("hex");
    const geo = audienceGeo(headers, env);
    await supabaseRequest("rpc/iev_record_audience", { method: "POST", body: {
      p_event_id: eventId, p_visitor: visitor, p_event: event, p_check_id: checkId,
      p_source: SOURCES.has(body.source) ? body.source : "direct",
      p_country: geo.country, p_state: geo.state, p_region: geo.region,
    } }, env);
  } catch (error) { reportStorageError("audience-write", "supabase", error); }
  return reply();
}

function stringParam(value) { return typeof value === "string" ? value.trim() : value === undefined ? "" : null; }
export function parseAudienceQuery(query = {}, now = new Date()) {
  if ([query.period, query.scope, query.page].some((value) => value !== undefined && typeof value !== "string")) return null;
  const period = stringParam(query.period) || "7d";
  const scope = stringParam(query.scope) || "all";
  const region = stringParam(query.region);
  const state = stringParam(query.state);
  const source = stringParam(query.source);
  const checkId = stringParam(query.checkId);
  const search = stringParam(query.q);
  const page = query.page === undefined ? 0 : Number(query.page);
  if (!["today", "7d", "30d", "90d", "custom"].includes(period) || !["all", "shared"].includes(scope) || [region, state, source, checkId, search].includes(null) || (region && !Object.values(REGIONS).includes(region)) || (state && !Object.hasOwn(REGIONS, state)) || (source && !SOURCES.has(source)) || (checkId && !validCheckId(checkId)) || search.length > 100 || !Number.isInteger(page) || page < 0 || page > 10000) return null;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  let from, to;
  if (period === "custom") {
    const start = stringParam(query.from), end = stringParam(query.to);
    const day = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value ?? "") && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
    if (!day(start) || !day(end)) return null;
    from = new Date(`${start}T00:00:00-03:00`);
    to = new Date(new Date(`${end}T00:00:00-03:00`).getTime() + 86400000);
    if (from >= to || to - from > 90 * 86400000 || from < new Date(`${today}T00:00:00-03:00`).getTime() - 89 * 86400000 || from > now) return null;
  } else {
    to = now;
    const days = { today: 1, "7d": 7, "30d": 30, "90d": 90 }[period];
    from = new Date(new Date(`${today}T00:00:00-03:00`).getTime() - (days - 1) * 86400000);
  }
  return { period, scope, region, state, source, checkId, search, page, from: from.toISOString(), to: new Date(Math.min(to.getTime(), now.getTime())).toISOString() };
}

export async function audienceSnapshot(query, env = process.env) {
  const filters = parseAudienceQuery(query);
  if (!filters) return { status: 400, body: { error: "invalid_audience_query", message: "Escolha um período válido de até 90 dias e confira os filtros." } };
  if (!supabaseConfigured(env)) return { status: 200, body: { audience: null, unavailable: "Audiência requer Supabase configurado no servidor." } };
  try {
    const { data } = await supabaseRequest("rpc/iev_audience_snapshot", { method: "POST", body: {
      p_from: filters.from, p_to: filters.to, p_check_id: filters.checkId || null,
      p_scope: filters.scope, p_region: filters.region || null, p_state: filters.state || null,
      p_source: filters.source || null, p_query: filters.search, p_offset: filters.page * 15, p_limit: 15,
    } }, env);
    if (!data || typeof data !== "object" || !data.summary || !Array.isArray(data.links)) throw new Error("invalid_snapshot");
    return { status: 200, body: { audience: data, filters, enabled: env.IEV_AUDIENCE_ENABLED !== "0" } };
  } catch (error) {
    reportStorageError("audience-read", "supabase", error);
    return { status: 502, body: { error: "audience_unavailable", message: error?.status === 404 ? "A migração de audiência ainda não foi aplicada ao Supabase." : "Não foi possível carregar a audiência. Os contadores estão indisponíveis, não zerados." } };
  }
}
