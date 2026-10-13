// Fronteira de rede compartilhada: parsing estrito de URL, bloqueio de destinos
// internos (IPv4/IPv6, incluindo mapeados, NAT64, 6to4 e Teredo), revalidação em
// cada salto de redirect e busca HTTP com teto de bytes por transferência.
// Usado por server/media.js, server/evidence.js e worker/server.js.
// Somente módulos nativos do Node — o worker copia este arquivo no container.
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";

export const DEFAULT_USER_AGENT = "issoeverdade/0.1 (+verificador de fatos)";

export class NetError extends Error {
  constructor(code, message, extra = {}) {
    super(message ?? code);
    this.name = "NetError";
    this.code = code;
    Object.assign(this, extra);
  }
}

// --- Endereços internos -----------------------------------------------------

const V4_BLOCKS = [
  ["0.0.0.0", 8],        // "esta rede" / 0.0.0.0
  ["10.0.0.0", 8],       // privada
  ["100.64.0.0", 10],    // CGNAT
  ["127.0.0.0", 8],      // loopback
  ["169.254.0.0", 16],   // link-local (inclui metadados 169.254.169.254)
  ["172.16.0.0", 12],    // privada
  ["192.0.0.0", 24],     // IANA/anycast
  ["192.0.2.0", 24],     // documentação
  ["192.88.99.0", 24],   // 6to4 relay
  ["192.168.0.0", 16],   // privada
  ["198.18.0.0", 15],    // benchmark
  ["198.51.100.0", 24],  // documentação
  ["203.0.113.0", 24],   // documentação
  ["224.0.0.0", 4],      // multicast
  ["240.0.0.0", 4],      // reservado / broadcast
];

function v4Parts(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => Number(part));
  return nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? nums : null;
}

function v4Number(parts) {
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function isBlockedV4(parts) {
  const value = v4Number(parts);
  return V4_BLOCKS.some(([base, bits]) => {
    const baseParts = v4Parts(base);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (v4Number(baseParts) & mask);
  });
}

/** Expande um IPv6 para 8 grupos de 16 bits, aceitando IPv4 embutido no final. */
function v6Groups(ip) {
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const expand = (value) => {
    if (!value) return [];
    const out = [];
    for (const part of value.split(":")) {
      if (part.includes(".")) {
        const v4 = v4Parts(part);
        if (!v4) return null;
        out.push((v4[0] << 8) + v4[1], (v4[2] << 8) + v4[3]);
      } else if (/^[0-9a-fA-F]{1,4}$/.test(part)) {
        out.push(parseInt(part, 16));
      } else {
        return null;
      }
    }
    return out;
  };
  const left = expand(halves[0]);
  const right = halves.length === 2 ? expand(halves[1]) : [];
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const zeros = 8 - left.length - right.length;
  if (zeros < 0) return null;
  return [...left, ...Array(zeros).fill(0), ...right];
}

/** IPv4 embutido em endereços mapeados/compatíveis/NAT64/6to4/Teredo. */
function embeddedV4(groups) {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const v4From = (hi, lo) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) return v4From(g6, g7);
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return v4From(g6, g7);
  if (g0 === 0x2002) return v4From(g1, g2);
  if (g0 === 0x2001 && g1 === 0) return v4From(g6, g7);
  return null;
}

function isBlockedV6(groups) {
  const [g0, g1, g2, g3] = groups;
  if (groups.every((group) => group === 0)) return true;               // ::
  if (g0 === 0 && g1 === 0 && groups.slice(2, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1
  if ((g0 & 0xffc0) === 0xfe80) return true;                          // link-local
  if ((g0 & 0xfe00) === 0xfc00) return true;                          // unique local
  if ((g0 & 0xff00) === 0xff00) return true;                          // multicast
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // discard
  if (g0 === 0x2001 && g1 === 0x0db8) return true;                    // documentação
  if (g0 === 0x2001 && (g1 & 0xfff0) === 0x0010) return true;         // ORCHID
  return false;
}

/** Endereço público (roteável na Internet) — base do bloqueio de SSRF. */
export function isPublicAddress(ip) {
  const version = isIP(ip);
  if (version === 4) {
    const parts = v4Parts(ip);
    return parts ? !isBlockedV4(parts) : false;
  }
  if (version === 6) {
    const groups = v6Groups(ip);
    if (!groups) return false;
    const embedded = embeddedV4(groups);
    if (embedded) return isPublicAddress(embedded.join("."));
    return !isBlockedV6(groups);
  }
  return false;
}

// --- Política de URL --------------------------------------------------------

const BLOCKED_HOST_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home.arpa", ".in-addr.arpa", ".ip6.arpa", ".onion", ".test", ".example", ".invalid"];
const BLOCKED_HOSTS = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data", "kubernetes", "kubernetes.default", "host.docker.internal", "gateway.docker.internal"]);

export function hostPolicy(env = process.env) {
  const ports = String(env.IEV_HTTP_PORTS ?? "80,443")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0 && value < 65536);
  return {
    allowPrivate: env.IEV_ALLOW_PRIVATE_HOSTS === "1",
    ports: ports.length ? ports : [80, 443],
  };
}

function isBlockedHostname(host) {
  if (BLOCKED_HOSTS.has(host)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (!host.includes(".")) return true; // nome de rótulo único: só resolve em rede interna
  return false;
}

/** Host normalizado da URL (sem colchetes de IPv6, sem ponto final). */
export function urlHost(url) {
  const raw = String(url?.hostname ?? "").toLowerCase().replace(/\.$/, "");
  return raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
}

/** Aceita apenas HTTP/HTTPS público, sem credenciais e em porta permitida. */
export function parseUrlStrict(value, { policy = hostPolicy() } = {}) {
  let url;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    throw new NetError("bad_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new NetError("bad_protocol");
  if (url.username || url.password) throw new NetError("url_credentials");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!policy.ports.includes(port)) throw new NetError("port_not_allowed", undefined, { port });
  const host = urlHost(url);
  if (!host) throw new NetError("bad_url");
  if (isIP(host)) {
    if (!policy.allowPrivate && !isPublicAddress(host)) throw new NetError("private_address", undefined, { address: host });
  } else if (!policy.allowPrivate && isBlockedHostname(host)) {
    throw new NetError("private_hostname", undefined, { host });
  }
  url.hash = "";
  return { url, host, port };
}

/** Resolve o host e recusa se qualquer endereço resolvido for interno. */
export async function resolvePublicHost(host, { policy = hostPolicy() } = {}) {
  const normalized = String(host ?? "").toLowerCase().replace(/\.$/, "");
  if (isIP(normalized)) {
    if (!policy.allowPrivate && !isPublicAddress(normalized)) throw new NetError("private_address", undefined, { address: normalized });
    return [{ address: normalized, family: isIP(normalized) }];
  }
  let rows;
  try {
    rows = await dnsLookup(normalized, { all: true, verbatim: true });
  } catch {
    throw new NetError("dns_failed", undefined, { host: normalized });
  }
  if (!Array.isArray(rows) || rows.length === 0) throw new NetError("dns_empty", undefined, { host: normalized });
  if (!policy.allowPrivate) {
    const blocked = rows.find((row) => !isPublicAddress(row.address));
    if (blocked) throw new NetError("private_address", undefined, { host: normalized, address: blocked.address });
  }
  return rows.map((row) => ({ address: row.address, family: row.family }));
}

/** lookup fixado nos endereços já validados: evita DNS rebinding entre validação e conexão. */
function pinnedLookup(addresses) {
  return (hostname, options, callback) => {
    const family = Number(options?.family) || 0;
    const list = family ? addresses.filter((item) => item.family === family) : addresses;
    if (!list.length) {
      callback(new NetError("no_address", undefined, { host: hostname }));
      return;
    }
    if (options?.all) {
      callback(null, list.map((item) => ({ address: item.address, family: item.family })));
      return;
    }
    callback(null, list[0].address, list[0].family);
  };
}

/** Orçamento de bytes por job: inclui todas as transferências e tentativas. */
export function byteBudget(totalBytes) {
  let used = 0;
  return {
    charge(bytes) {
      used += Number(bytes) || 0;
      if (used > totalBytes) throw new NetError("budget_exhausted", undefined, { used, totalBytes });
    },
    remaining() {
      return Math.max(0, totalBytes - used);
    },
    get used() {
      return used;
    },
    get totalBytes() {
      return totalBytes;
    },
  };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function requestOnce(url, addresses, { method, headers, body, maxBytes, truncate, timeoutMs, userAgent, accept, budget }) {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;
    const cap = budget ? Math.min(maxBytes, budget.remaining()) : maxBytes;
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          "User-Agent": userAgent,
          Accept: accept ?? "*/*",
          "Accept-Encoding": "identity",
          ...headers,
        },
        lookup: pinnedLookup(addresses),
        ...(isHttps && !isIP(url.hostname) ? { servername: url.hostname } : {}),
        agent: false,
        timeout: timeoutMs,
      },
      (res) => {
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > cap && !truncate) {
          res.destroy();
          req.destroy();
          done(reject, new NetError("too_large", undefined, { declared, limit: cap }));
          return;
        }
        if (REDIRECT_STATUSES.has(res.statusCode) && res.headers.location) {
          res.destroy();
          done(resolve, { status: res.statusCode, headers: res.headers, body: null, truncated: false });
          return;
        }
        const chunks = [];
        let total = 0;
        let truncated = false;
        res.on("data", (chunk) => {
          total += chunk.length;
          if (budget) {
            try {
              budget.charge(chunk.length);
            } catch (error) {
              res.destroy();
              req.destroy();
              done(reject, error);
              return;
            }
          }
          if (total > cap) {
            const keep = Math.max(0, chunk.length - (total - cap));
            if (keep > 0) chunks.push(chunk.subarray(0, keep));
            truncated = true;
            if (!truncate) {
              res.destroy();
              req.destroy();
              done(reject, new NetError("too_large", undefined, { limit: cap }));
              return;
            }
            total = cap;
            res.destroy();
            req.destroy();
            done(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), truncated: true });
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => done(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), truncated }));
        res.on("error", (error) => done(reject, error?.code === "ERR_STREAM_DESTROYED" ? new NetError("network_failed") : error));
      },
    );
    req.on("timeout", () => {
      req.destroy(new NetError("timeout"));
    });
    req.on("error", (error) => {
      done(reject, error instanceof NetError ? error : new NetError("network_failed", undefined, { detail: String(error?.message ?? error).slice(0, 200) }));
    });
    if (body) req.write(body);
    req.end();
  });
}

/**
 * GET/POST com teto de bytes, timeout único para a cadeia inteira e revalidação
 * de cada redirect. Lança NetError com código estável: bad_url, private_address,
 * port_not_allowed, dns_failed, timeout, too_large, budget_exhausted,
 * too_many_redirects, network_failed.
 */
export async function safeFetch(value, opts = {}) {
  const {
    method: initialMethod = "GET",
    headers = {},
    body = null,
    maxBytes = 2 * 1024 * 1024,
    truncate = false,
    maxRedirects = 3,
    timeoutMs = 15_000,
    policy = hostPolicy(),
    accept = null,
    userAgent = DEFAULT_USER_AGENT,
    budget = null,
  } = opts;
  let method = initialMethod.toUpperCase();
  let payload = body;
  let current = parseUrlStrict(value, { policy }).url;
  const redirects = [];
  const deadline = Date.now() + timeoutMs;
  for (let hop = 0; ; hop++) {
    const addresses = await resolvePublicHost(urlHost(current), { policy });
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new NetError("timeout");
    const response = await requestOnce(current, addresses, {
      method, headers, body: payload, maxBytes, truncate, timeoutMs: remaining, userAgent, accept, budget,
    });
    if (REDIRECT_STATUSES.has(response.status) && response.headers.location) {
      if (hop >= maxRedirects) throw new NetError("too_many_redirects");
      const next = new URL(String(response.headers.location), current);
      const parsed = parseUrlStrict(next.href, { policy });
      redirects.push({ status: response.status, from: current.href, to: parsed.url.href });
      current = parsed.url;
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== "GET" && method !== "HEAD")) {
        method = "GET";
        payload = null;
      }
      continue;
    }
    const ok = response.status >= 200 && response.status < 300;
    return { ok, status: response.status, headers: response.headers, body: response.body, truncated: response.truncated, finalUrl: current.href, redirects };
  }
}

/** Texto de corpo em UTF-8 limitado, com Content-Type textual. */
export function bodyText(response, limit = 1_000_000) {
  const text = Buffer.isBuffer(response?.body) ? response.body.toString("utf8") : "";
  return text.slice(0, limit);
}
