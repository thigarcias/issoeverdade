// Extração e comparação de texto: HTML → texto legível, normalização para
// busca de trecho e localização conservadora de citações em documentos obtidos.
// A ausência de trecho NUNCA é tratada aqui como prova de falsidade: quem chama
// decide como registrar a limitação.

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d", deg: "°",
};

export function decodeEntities(value) {
  return String(value ?? "").replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

const BLOCK_TAGS = /<\/?(?:p|div|br|li|ul|ol|tr|td|th|table|section|article|header|footer|h[1-6]|blockquote|figure|figcaption|pre|hr)\b[^>]*>/gi;

/** Converte HTML em texto legível, descartando script/style/svg e comentários. */
export function textFromHtml(html) {
  let text = String(html ?? "");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<(script|style|noscript|template|svg|iframe|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  text = text.replace(BLOCK_TAGS, "\n");
  text = text.replace(/<[^>]*>/g, " ");
  text = decodeEntities(text);
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripHtml(html) {
  if (typeof html !== "string") return "";
  return textFromHtml(html).replace(/\s+/g, " ").trim();
}

const QUOTE_MAP = new Map([
  ["\u2018", "'"], ["\u2019", "'"], ["\u201c", '"'], ["\u201d", '"'], ["\u00ab", '"'], ["\u00bb", '"'],
  ["\u2013", "-"], ["\u2014", "-"], ["\u2212", "-"], ["\u00ad", ""], ["\u200b", ""], ["\u2060", ""],
  ["\ufeff", ""], ["\u00a0", " "], ["\u2026", "..."],
]);

/** Normaliza para comparação: NFC, aspas/traços canônicos, espaços colapsados. */
export function normalizeForMatch(value) {
  let text = String(value ?? "").normalize("NFC");
  let out = "";
  for (const char of text) out += QUOTE_MAP.get(char) ?? char;
  return out.replace(/\s+/g, " ").trim();
}

/** Comparação secundária: ignora acentos e caixa (uso explícito e registrado). */
export function foldForMatch(value) {
  return normalizeForMatch(value)
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

/**
 * Dobra o texto preservando a correspondência de posições: cada caractere do
 * resultado aponta para o índice no texto original. Necessário para localizar
 * e recortar o trecho original mesmo quando acentos/caixa mudam de tamanho.
 */
export function foldWithMap(value) {
  const source = normalizeForMatch(value);
  let text = "";
  const map = [];
  for (let index = 0; index < source.length; index++) {
    const folded = source[index].normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
    for (const char of folded) {
      text += char;
      map.push(index);
    }
  }
  return { text, map };
}

function tokens(value) {
  return normalizeForMatch(value)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1);
}

/** Fração de tokens da citação presentes no trecho (0..1), multiconjunto. */
export function tokenOverlap(quote, haystack) {
  const quoteTokens = tokens(quote);
  if (quoteTokens.length === 0) return 0;
  const counts = new Map();
  for (const token of tokens(haystack)) counts.set(token, (counts.get(token) ?? 0) + 1);
  let hits = 0;
  for (const token of quoteTokens) {
    const available = counts.get(token) ?? 0;
    if (available > 0) {
      hits++;
      counts.set(token, available - 1);
    }
  }
  return hits / quoteTokens.length;
}

const PREFIX_CHARS = 60;
const FUZZY_THRESHOLD = 0.8;
const LOOSE_GAP = "[^\\p{L}\\p{N}]{0,6}";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Regex tolerante a pontuação: mesmos tokens na mesma ordem, com lacunas curtas.
 * Só usa tokens com dois ou mais caracteres e nunca gera backreference.
 */
function looseMatcher(quote) {
  const parts = tokens(quote).map(escapeRegExp);
  if (parts.length < 3) return null;
  try {
    return new RegExp(parts.join(LOOSE_GAP), "iu");
  } catch {
    return null;
  }
}

/**
 * Procura a citação no texto do documento, em níveis explícitos:
 * "exact" (literal) → "normalized" (sem acentos/caixa) → "approximate"
 * (mesmos tokens com pontuação diferente) → "prefix"/"tokens" (só sinal parcial).
 * O chamador deve registrar qual nível foi atingido; ausência de trecho não é
 * prova de falsidade.
 * @returns {{found:boolean, kind:"exact"|"normalized"|"approximate"|"prefix"|"tokens"|"missing"|"empty",
 *            index:number|null, similarity:number, excerpt:string|null, quoteChars:number}}
 */
export function locateQuote(documentText, quote, { excerptChars = 400 } = {}) {
  const normalizedQuote = normalizeForMatch(quote);
  const haystack = normalizeForMatch(documentText);
  const result = { found: false, kind: "missing", index: null, similarity: 0, excerpt: null, quoteChars: normalizedQuote.length };
  if (normalizedQuote.length < 12 || haystack.length === 0) {
    result.kind = normalizedQuote.length === 0 ? "empty" : "missing";
    return result;
  }
  const excerptFrom = (start, end) => haystack.slice(start, Math.max(end, start + excerptChars));
  const exactIndex = haystack.toLowerCase().indexOf(normalizedQuote.toLowerCase());
  if (exactIndex >= 0) {
    return {
      found: true,
      kind: "exact",
      index: exactIndex,
      similarity: 1,
      excerpt: excerptFrom(exactIndex, exactIndex + normalizedQuote.length),
      quoteChars: normalizedQuote.length,
    };
  }
  // Níveis seguintes comparam texto dobrado (sem acentos/caixa), mas recortam o
  // trecho original usando o mapa de posições.
  const folded = foldWithMap(haystack);
  const foldIndex = (needle) => (needle.length ? folded.text.indexOf(needle) : -1);
  const foldedQuote = foldForMatch(normalizedQuote);
  const spanOf = (start, length) => {
    const originalStart = folded.map[start] ?? 0;
    const lastIndex = Math.min(start + Math.max(length, 1) - 1, folded.map.length - 1);
    const originalEnd = (folded.map[lastIndex] ?? originalStart) + 1;
    return { start: originalStart, end: Math.max(originalEnd, originalStart + 1) };
  };
  const normalizedIndex = foldIndex(foldedQuote);
  if (normalizedIndex >= 0) {
    const span = spanOf(normalizedIndex, foldedQuote.length);
    return {
      found: true,
      kind: "normalized",
      index: span.start,
      similarity: 1,
      excerpt: excerptFrom(span.start, span.end),
      quoteChars: normalizedQuote.length,
    };
  }
  const matcher = looseMatcher(foldedQuote);
  const loose = matcher?.exec(folded.text) ?? null;
  if (loose) {
    const span = spanOf(loose.index, loose[0].length);
    const similarity = tokenOverlap(foldedQuote, loose[0]);
    return {
      found: similarity >= FUZZY_THRESHOLD,
      kind: similarity >= FUZZY_THRESHOLD ? "approximate" : "prefix",
      index: span.start,
      similarity,
      excerpt: excerptFrom(span.start, span.end),
      quoteChars: normalizedQuote.length,
    };
  }
  const prefixIndex = foldIndex(foldedQuote.slice(0, PREFIX_CHARS));
  if (prefixIndex < 0) {
    result.similarity = tokenOverlap(foldedQuote, folded.text);
    result.kind = "tokens";
    return result;
  }
  const span = spanOf(prefixIndex, Math.round(foldedQuote.length * 1.2));
  const similarity = tokenOverlap(foldedQuote, folded.text.slice(prefixIndex, prefixIndex + Math.round(foldedQuote.length * 1.2)));
  result.index = span.start;
  result.similarity = similarity;
  result.excerpt = excerptFrom(span.start, span.end);
  result.kind = similarity >= FUZZY_THRESHOLD ? "approximate" : "prefix";
  result.found = similarity >= FUZZY_THRESHOLD;
  return result;
}

/** Corte seguro por frases, usado em resumos públicos e logs. */
export function clip(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
