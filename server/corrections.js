// Canal público de contestação e fila privada de correções.
// Regras de produto:
//   - cada pedido recebe protocolo verificável e entra numa fila com estados;
//   - revisão é humana: a IA pode auxiliar, mas não altera resultado histórico;
//   - correção preserva a execução original e marca a versão vigente;
//   - sem armazenamento durável em produção, o endpoint recusa (nunca confirma
//     um protocolo que não foi gravado).
const INDEX_KEY = "iev-corrections/index.json";
const MAX_INDEX = 500;
const MEMORY_MAX = 200;

export const CORRECTION_STATUSES = [
  { id: "received", label: "Recebido" },
  { id: "in_review", label: "Em revisão" },
  { id: "awaiting_info", label: "Aguardando informação" },
  { id: "corrected", label: "Corrigido" },
  { id: "maintained", label: "Mantido" },
  { id: "closed", label: "Encerrado" },
];

const STATUS_IDS = new Set(CORRECTION_STATUSES.map((status) => status.id));
const MAX_MESSAGE = 4000;
const MIN_MESSAGE = 20;
const MAX_CONTACT = 300;
const MAX_URL = 500;

const memory = new Map();
let indexMemory = [];

function blobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN || "";
}

export function correctionsEnabled() {
  return Boolean(blobToken());
}

/** Em produção sem Blob o canal é recusado; em dev fica em memória com aviso. */
export function correctionsMode(env = process.env) {
  if (correctionsEnabled()) return "durable";
  const production = env.VERCEL_ENV === "production" || env.NODE_ENV === "production" || env.IEV_PRODUCTION === "1";
  return production ? "blocked" : "memory";
}

function makeProtocol() {
  const random = Math.random().toString(36).slice(2, 8);
  return `corr-${Date.now().toString(36)}-${random}`;
}

function clean(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Valida o pedido público. Recusa corpo acima do contrato em vez de truncar
 * silenciosamente a mensagem do solicitante.
 */
export function normalizeCorrection(body) {
  const message = String(body?.message ?? "");
  if (message.trim().length < MIN_MESSAGE) return { ok: false, error: "message_too_short", status: 400 };
  if (message.length > MAX_MESSAGE) return { ok: false, error: "message_too_long", status: 413 };
  const checkId = clean(body?.checkId, 80);
  if (checkId && !/^[a-z0-9-]+$/i.test(checkId)) return { ok: false, error: "bad_check_id", status: 400 };
  const evidenceUrl = clean(body?.evidenceUrl, MAX_URL);
  if (evidenceUrl && !/^https?:\/\//i.test(evidenceUrl)) return { ok: false, error: "bad_evidence_url", status: 400 };
  const contact = clean(body?.contact, MAX_CONTACT);
  const claim = clean(body?.claim, 600);
  return {
    ok: true,
    value: {
      protocol: makeProtocol(),
      checkId: checkId || null,
      message: message.trim().slice(0, MAX_MESSAGE),
      claim: claim || null,
      evidenceUrl: evidenceUrl || null,
      contact: contact || null,
      kind: ["correction", "right_of_reply", "removal"].includes(body?.kind) ? body.kind : "correction",
    },
  };
}

function indexEntry(record) {
  return {
    protocol: record.protocol,
    at: record.at,
    updatedAt: record.updatedAt,
    status: record.status,
    checkId: record.checkId,
    kind: record.kind,
    messagePreview: record.message.slice(0, 240),
  };
}

async function blob() {
  return import("@vercel/blob");
}

async function readIndex() {
  if (!correctionsEnabled()) return { items: indexMemory };
  try {
    const { list } = await blob();
    const found = await list({ prefix: INDEX_KEY, token: blobToken() });
    const item = found.blobs.find((entry) => entry.pathname === INDEX_KEY);
    if (!item) return { items: [] };
    const response = await fetch(item.url, { headers: { Authorization: `Bearer ${blobToken()}` } });
    if (!response.ok) return { items: [] };
    const body = await response.json();
    return { items: Array.isArray(body?.items) ? body.items : [] };
  } catch {
    return { items: [] };
  }
}

async function writeIndex(items) {
  const trimmed = items.slice(0, MAX_INDEX);
  if (!correctionsEnabled()) {
    indexMemory = trimmed;
    return;
  }
  const { put } = await blob();
  await put(INDEX_KEY, JSON.stringify({ items: trimmed }), {
    access: "private",
    contentType: "application/json",
    token: blobToken(),
    allowOverwrite: true,
  });
}

async function readRecord(protocol) {
  if (!/^[a-z0-9-]+$/i.test(protocol)) return null;
  if (!correctionsEnabled()) return memory.get(protocol) ?? null;
  try {
    const { list } = await blob();
    const pathname = `iev-corrections/${protocol}.json`;
    const found = await list({ prefix: pathname, token: blobToken() });
    const item = found.blobs.find((entry) => entry.pathname === pathname);
    if (!item) return null;
    const response = await fetch(item.url, { headers: { Authorization: `Bearer ${blobToken()}` } });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function writeRecord(record) {
  if (!correctionsEnabled()) {
    memory.set(record.protocol, record);
    if (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value);
    return;
  }
  const { put } = await blob();
  await put(`iev-corrections/${record.protocol}.json`, JSON.stringify(record), {
    access: "private",
    contentType: "application/json",
    token: blobToken(),
    allowOverwrite: true,
  });
}

/** Cria o pedido e devolve o registro privado (com contato). */
export async function createCorrection(value) {
  const now = new Date().toISOString();
  const record = {
    ...value,
    status: "received",
    at: now,
    updatedAt: now,
    history: [{ at: now, status: "received", actor: "público", note: null }],
    persisted: correctionsEnabled(),
  };
  await writeRecord(record);
  const { items } = await readIndex();
  await writeIndex([indexEntry(record), ...items.filter((item) => item.protocol !== record.protocol)]);
  return record;
}

export async function listCorrections() {
  const { items } = await readIndex();
  return {
    enabled: correctionsEnabled(),
    mode: correctionsMode(),
    max: MAX_INDEX,
    statuses: CORRECTION_STATUSES,
    items: items.slice(0, MAX_INDEX),
  };
}

export async function getCorrection(protocol) {
  return readRecord(protocol);
}

/** Atualiza estado/motivo preservando o histórico. */
export async function updateCorrection(protocol, { status, note, actor } = {}) {
  if (status && !STATUS_IDS.has(status)) return { ok: false, error: "bad_status", status: 400 };
  const record = await readRecord(protocol);
  if (!record) return { ok: false, error: "not_found", status: 404 };
  const now = new Date().toISOString();
  const updated = {
    ...record,
    status: status ?? record.status,
    updatedAt: now,
    history: [...(record.history ?? []), { at: now, status: status ?? record.status, actor: actor ?? "admin", note: clean(note, 1000) || null }],
  };
  await writeRecord(updated);
  const { items } = await readIndex();
  await writeIndex([indexEntry(updated), ...items.filter((item) => item.protocol !== protocol)]);
  return { ok: true, record: updated };
}

/** Visão pública: sem contato e sem notas internas. */
export function publicCorrection(record) {
  if (!record) return null;
  return {
    protocol: record.protocol,
    status: record.status,
    at: record.at,
    updatedAt: record.updatedAt,
    checkId: record.checkId,
    kind: record.kind,
    statusLabel: CORRECTION_STATUSES.find((status) => status.id === record.status)?.label ?? record.status,
    history: (record.history ?? []).map((entry) => ({ at: entry.at, status: entry.status })),
  };
}

/** Resumo para o painel administrativo (inclui contato, uso interno). */
export function adminCorrection(record) {
  return {
    protocol: record.protocol,
    status: record.status,
    at: record.at,
    updatedAt: record.updatedAt,
    checkId: record.checkId,
    kind: record.kind,
    message: record.message,
    claim: record.claim,
    evidenceUrl: record.evidenceUrl,
    contact: record.contact,
    history: record.history ?? [],
    persisted: record.persisted !== false,
  };
}
