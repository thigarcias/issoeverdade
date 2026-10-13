import { createHash } from "node:crypto";

const MAX_FILE_BYTES = 3 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_FILE_BYTES / 3) * 4;
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MEDIA_MIMES = new Set([
  ...IMAGE_MIMES,
  "video/mp4", "video/quicktime", "video/webm",
  "audio/mpeg", "audio/mp4", "audio/wav", "audio/webm", "audio/ogg",
]);

function detectedMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp") {
    return bytes.toString("ascii", 8, 12) === "qt  " ? "video/quicktime" : "video/mp4";
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") return "audio/wav";
  if (bytes.length >= 4 && bytes.toString("ascii", 0, 4) === "OggS") return "audio/ogg";
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "video/webm";
  if (bytes.length >= 3 && bytes.toString("ascii", 0, 3) === "ID3") return "audio/mpeg";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "audio/mpeg";
  return null;
}

function mimeCompatible(declared, detected) {
  if (!declared) return true;
  const aliases = {
    "image/jpg": "image/jpeg",
    "audio/x-wav": "audio/wav",
    "audio/mp3": "audio/mpeg",
  };
  const normalized = aliases[declared] ?? declared;
  return normalized === detected ||
    (normalized === "audio/mp4" && detected === "video/mp4") ||
    (normalized === "audio/webm" && detected === "video/webm");
}

export function normalizeVerifyInput(value) {
  const kind = value?.kind;
  if (!["link", "text", "video", "image"].includes(kind)) {
    const error = new Error("bad_kind");
    error.status = 400;
    throw error;
  }
  const text = String(value?.text ?? "").slice(0, 8000);
  const fileName = value?.fileName ? String(value.fileName).slice(0, 200) : null;
  const out = { kind, text, fileName, fileBuffer: null, fileMime: null, fileHash: null };
  if ((value?.fileData == null || value.fileData === "") && !Buffer.isBuffer(value?.fileBuffer)) return out;
  if (kind !== "video" && kind !== "image") {
    const error = new Error("upload_not_allowed_for_kind");
    error.status = 400;
    throw error;
  }

  let bytes;
  if (Buffer.isBuffer(value.fileBuffer)) {
    bytes = value.fileBuffer;
  } else {
    const encoded = String(value.fileData);
    if (encoded.length > MAX_BASE64_CHARS || encoded.length === 0 || encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      const error = new Error("invalid_upload_encoding");
      error.status = 400;
      throw error;
    }
    bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) {
      const error = new Error("invalid_upload_encoding");
      error.status = 400;
      throw error;
    }
  }
  if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) {
    const error = new Error("upload_too_large");
    error.status = 413;
    throw error;
  }
  const declared = String(value?.fileMime ?? "").toLowerCase().split(";")[0].trim();
  const mime = detectedMime(bytes);
  if (!mime || !MEDIA_MIMES.has(mime) || !mimeCompatible(declared, mime) || (kind === "image" && !IMAGE_MIMES.has(mime)) || (kind === "video" && IMAGE_MIMES.has(mime))) {
    const error = new Error("unsupported_upload_type");
    error.status = 415;
    throw error;
  }
  out.fileBuffer = bytes;
  out.fileMime = mime;
  out.fileHash = createHash("sha256").update(bytes).digest("hex");
  return out;
}

export const MAX_UPLOAD_BYTES = MAX_FILE_BYTES;
