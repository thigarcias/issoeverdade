import { parseUrlStrict } from "./net.js";

const SOCIAL_DOMAINS = [
  "x.com", "twitter.com", "instagram.com", "facebook.com", "fb.watch",
  "threads.net", "threads.com", "tiktok.com", "youtube.com", "youtu.be",
  "vimeo.com", "twitch.tv", "reddit.com", "kwai.com", "pinterest.com",
  "linkedin.com", "spotify.com",
];

const EXTENSION_TYPES = new Map([
  ["pdf", "pdf"],
  ["jpg", "image"], ["jpeg", "image"], ["png", "image"], ["webp", "image"], ["gif", "image"], ["svg", "image"],
  ["mp4", "video"], ["mov", "video"], ["m4v", "video"], ["webm", "video"],
  ["mp3", "audio"], ["wav", "audio"], ["m4a", "audio"], ["ogg", "audio"], ["opus", "audio"], ["flac", "audio"],
]);

function matchesDomain(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function mediaTypeFromMime(value) {
  const mime = String(value ?? "").toLowerCase().split(";")[0].trim();
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return null;
}

function isSocialMediaCandidate(host, path) {
  if ((host === "x.com" || host === "twitter.com") && /\/[^/]+\/status\/\d+/.test(path)) return true;
  if (host === "youtube.com" || host === "youtu.be") return host === "youtu.be" ? path !== "/" : /\/(?:watch|shorts|live|embed)\//.test(`${path}/`);
  if (host === "instagram.com") return /\/(?:p|reel|reels|tv)\//.test(path);
  if (host === "tiktok.com") return /\/@[^/]+\/video\//.test(path);
  if (host === "facebook.com" || host === "fb.watch") return /\/(?:watch|videos?|reel|reels|live)\b/.test(path) || host === "fb.watch";
  if (host === "threads.net" || host === "threads.com") return /\/post\//.test(path);
  if (host === "reddit.com") return /\/comments\/|\/video\//.test(path);
  if (host === "kwai.com") return /\/(?:photo|video|play)\//.test(path) || path.split("/").filter(Boolean).length > 0;
  if (host === "vimeo.com") return /\/\d+(?:\/|$)/.test(path) || /\/(?:channels|groups|showcase)\//.test(path);
  if (host === "twitch.tv") return /\/(?:videos|clip)\//.test(path) || /\/[^/]+\/clip\//.test(path);
  if (host === "spotify.com") return /\/episode\//.test(path);
  return false;
}
/** Hosts cujo mediaCandidate de path é frágil: posts de texto/foto sem vídeo são comuns. */
const PRESENCE_CHECKED_MEDIA_HOSTS = ["x.com", "twitter.com"];

/**
 * Indica que a presença de áudio/vídeo deve ser confirmada antes de anunciar
 * ou baixar mídia: aqui o path do post não revela se existe anexo audiovisual.
 */
export function mediaPresenceUncertain(host) {
  const normalized = String(host ?? "").toLowerCase().replace(/\.$/, "");
  return PRESENCE_CHECKED_MEDIA_HOSTS.some((domain) => normalized === domain || normalized.endsWith(`.${domain}`));
}

function mediaTypeFromContent(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.alloc(0);
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "pdf";
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF") {
    if (bytes.subarray(8, 12).toString("ascii") === "WAVE") return "audio";
    if (bytes.subarray(8, 12).toString("ascii") === "AVI ") return "video";
    if (bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image";
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("ascii");
    return /^M4[ABP ]$/.test(brand) ? "audio" : "video";
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "video";
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString("ascii") === "OggS") return "audio";
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString("ascii") === "fLaC") return "audio";
  if (bytes.length >= 3 && bytes.subarray(0, 3).toString("ascii") === "ID3") return "audio";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "audio";
  return null;
}


/**
 * Conservative URL classification. Social hosts identify post context, not media;
 * `mediaCandidate` is a path-level hint and never asserts that media was read.
 */
export function classifySourceUrl(value, { contentType = "", contentPrefix = null } = {}) {
  let url;
  try {
    url = parseUrlStrict(value).url;
  } catch {
    return { type: "unknown", mediaCandidate: false, social: false, finalUrl: null };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const normalizedMime = String(contentType ?? "").toLowerCase().split(";")[0].trim();
  const mimeType = mediaTypeFromMime(normalizedMime);
  const prefixType = (!normalizedMime || normalizedMime === "application/octet-stream") ? mediaTypeFromContent(contentPrefix) : null;
  const textualMime = /^text\//.test(normalizedMime) || /^(?:application\/(?:xhtml\+xml|xml|json|rss\+xml))$/.test(normalizedMime);
  const authoritativeMime = normalizedMime && normalizedMime !== "application/octet-stream";
  const extension = url.pathname.match(/\.([^./]+)$/)?.[1]?.toLowerCase() ?? "";
  const pathType = EXTENSION_TYPES.get(extension) ?? null;
  const social = SOCIAL_DOMAINS.some((domain) => matchesDomain(host, domain));
  const canonicalSocialHost = SOCIAL_DOMAINS.find((domain) => matchesDomain(host, domain));
  const spotifyEpisode = canonicalSocialHost === "spotify.com" && /^\/episode(?:\/|$)/i.test(url.pathname);
  const type = mimeType ?? prefixType ?? (spotifyEpisode ? "audio" : textualMime ? (social ? "social" : "html") : authoritativeMime ? "unsupported" : pathType ?? (social ? "social" : "html"));
  const mediaCandidate = type === "video" || type === "audio" ||
    (type === "social" && isSocialMediaCandidate(canonicalSocialHost, url.pathname));
  return { type, mediaCandidate, social, host, finalUrl: url.href, contentType: normalizedMime || null };
}

export { mediaTypeFromMime };
