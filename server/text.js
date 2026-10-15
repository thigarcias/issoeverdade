// Extração e comparação de texto: HTML → texto legível, normalização para
// busca de trecho e localização conservadora de citações em documentos obtidos.
// A ausência de trecho NUNCA é tratada aqui como prova de falsidade: quem chama
// decide como registrar a limitação.

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d", deg: "°",
  copy: "©", reg: "®", trade: "™", euro: "€", cent: "¢", pound: "£", yen: "¥",
  Agrave: "À", Aacute: "Á", Acirc: "Â", Atilde: "Ã", Auml: "Ä", Aring: "Å", AElig: "Æ",
  Ccedil: "Ç", Egrave: "È", Eacute: "É", Ecirc: "Ê", Euml: "Ë",
  Igrave: "Ì", Iacute: "Í", Icirc: "Î", Iuml: "Ï", ETH: "Ð", Ntilde: "Ñ",
  Ograve: "Ò", Oacute: "Ó", Ocirc: "Ô", Otilde: "Õ", Ouml: "Ö", times: "×",
  Oslash: "Ø", Ugrave: "Ù", Uacute: "Ú", Ucirc: "Û", Uuml: "Ü", Yacute: "Ý", THORN: "Þ",
  szlig: "ß", agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä", aring: "å",
  aelig: "æ", ccedil: "ç", egrave: "è", eacute: "é", ecirc: "ê", euml: "ë",
  igrave: "ì", iacute: "í", icirc: "î", iuml: "ï", eth: "ð", ntilde: "ñ",
  ograve: "ò", oacute: "ó", ocirc: "ô", otilde: "õ", ouml: "ö", divide: "÷",
  oslash: "ø", ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý", thorn: "þ",
  yuml: "ÿ",
};

const MAX_LOOSE_TOKENS = 30;

export function decodeEntities(value) {
  return String(value ?? "").replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity] ?? match;
  });
}

export function pageMeta(html, name) {
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = {};
    for (const attr of tag[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs[attr[1].toLowerCase()] = decodeEntities(attr[2] ?? attr[3] ?? attr[4]);
    }
    if ((attrs.property ?? attrs.name)?.toLowerCase() === name.toLowerCase()) return attrs.content?.trim() ?? "";
  }
  return "";
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
    // Tags inline não devem criar "nome ," onde o documento dizia "nome,".
    .replace(/([\p{L}"')]) (?=[,.;:!?])/gu, "$1")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripHtml(html) {
  if (typeof html !== "string") return "";
  return textFromHtml(html).replace(/\s+/g, " ").trim();
}

/** Recupera artigo estruturado, priorizando o maior corpo; metadados não provam conteúdo ausente. */
export function structuredArticle(html) {
  let best = null;
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 6) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
    if (types.some((type) => /(?:^|\/)(?:NewsArticle|Article|ReportageNewsArticle|AnalysisNewsArticle|BlogPosting)$/i.test(String(type))) &&
        (typeof node.articleBody === "string" || typeof node.headline === "string") &&
        (!best || (typeof node.articleBody === "string" ? node.articleBody.length : 0) > (typeof best.articleBody === "string" ? best.articleBody.length : 0))) best = node;
    for (const child of Object.values(node)) if (child && typeof child === "object") visit(child, depth + 1);
  };
  for (const script of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try { visit(JSON.parse(script[1])); } catch {}
  }
  return best;
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
  const parts = tokens(quote);
  if (parts.length < 3 || parts.length > MAX_LOOSE_TOKENS) return null;
  const escaped = parts.map(escapeRegExp);
  try {
    return new RegExp(escaped.join(LOOSE_GAP), "iu");
  } catch {
    return null;
  }
}

const EDITORIAL_OMISSION = /\[\s*\.{3}\s*\]|\(\s*\.{3}\s*\)/u;
const MAX_OMISSION_GAP = 240;
const MAX_OMISSION_SPAN = 1000;
const TRIVIAL_ANCHORS = new Set(["para", "como", "mais", "isso", "isto", "essa", "esse", "esta", "este", "pela", "pelo", "pelas", "pelos", "entre", "sobre", "mesmo", "tambem", "apenas"]);

/**
 * Omissões editoriais exigem 1–4 fragmentos literais, cada um com duas palavras,
 * seis letras/dígitos e uma âncora não trivial de quatro caracteres. Só nas bordas,
 * um marcador pode substituir texto sem outra âncora; pontuação editorial externa
 * não faz parte do trecho. O conjunto exige 40 caracteres e oito palavras.
 * Não há fuzzy dentro dos fragmentos nem reconstrução do texto cortado nas bordas.
 * A busca é ordenada, limitada a 240 caracteres normalizados/dobrados por omissão
 * interna, 1000 no intervalo e 128 candidatos; nunca combina documentos ou retorna colagem.
 */
function locateEditorialOmission(haystack, quote) {
  const fragments = quote.split(EDITORIAL_OMISSION).map((part) => foldForMatch(part));
  const editorialEdge = /^[\s.,;:!?'"-]*$/u;
  if (fragments.length > 1 && editorialEdge.test(fragments[0])) fragments.shift();
  if (fragments.length > 1 && editorialEdge.test(fragments.at(-1))) fragments.pop();
  if (fragments.length < 1 || fragments.length > 4 || fragments.join(" ").length < 40) return null;
  let wordCount = 0;
  for (const fragment of fragments) {
    const words = fragment.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (words.length < 2 || words.join("").length < 6 ||
        !words.some((word) => word.length >= 4 && !TRIVIAL_ANCHORS.has(word))) return null;
    wordCount += words.length;
  }
  if (wordCount < 8) return null;
  let candidates = 0;
  const search = (part, from, firstStart, previousEnd) => {
    const fragment = fragments[part];
    let index = haystack.indexOf(fragment, from);
    while (index >= 0 && candidates < 128) {
      const end = index + fragment.length;
      if (part > 0 && (index - previousEnd > MAX_OMISSION_GAP ||
          end - firstStart > MAX_OMISSION_SPAN)) break;
      candidates++;
      const boundedStart = !/[\p{L}\p{N}]/u.test(fragment[0]) ||
        !/[\p{L}\p{N}]/u.test(haystack[index - 1] ?? "");
      const boundedEnd = !/[\p{L}\p{N}]/u.test(fragment.at(-1)) ||
        !/[\p{L}\p{N}]/u.test(haystack[end] ?? "");
      const omittedText = part === 0 ? "" : haystack.slice(previousEnd, index);
      if (boundedStart && boundedEnd && (part === 0 || /[\p{L}\p{N}]/u.test(omittedText))) {
        const start = part === 0 ? index : firstStart;
        if (end - start <= MAX_OMISSION_SPAN) {
          if (part === fragments.length - 1) return { start, end };
          const span = search(part + 1, end, start, end);
          if (span) return span;
        }
      }
      index = haystack.indexOf(fragment, index + 1);
    }
    return null;
  };
  return search(0, 0, 0, 0);
}

/**
 * Procura a citação no texto do documento, em níveis explícitos:
 * "exact" (literal) → "normalized" (sem acentos/caixa) → "approximate"
 * (omissão editorial explícita e limitada, ou mesmos tokens com pontuação
 * diferente) → "prefix"/"tokens" (só sinal parcial).
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
  const excerptFrom = (start, end) => {
    const size = Math.max(excerptChars, end - start);
    const before = Math.floor((size - (end - start)) / 2);
    const windowStart = Math.max(0, start - before);
    const windowEnd = Math.min(haystack.length, windowStart + size);
    return haystack.slice(Math.max(0, windowEnd - size), windowEnd);
  };
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
  // Uma omissão malsucedida não pode cair no fuzzy/prefixo e confirmar uma
  // colagem incompleta. Os fragmentos só são comparados literalmente dobrados.
  if (EDITORIAL_OMISSION.test(normalizedQuote)) {
    const omission = locateEditorialOmission(folded.text, normalizedQuote);
    if (!omission) return result;
    const span = spanOf(omission.start, omission.end - omission.start);
    return {
      found: true,
      kind: "approximate",
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
  result.kind = similarity >= FUZZY_THRESHOLD && tokens(foldedQuote).length <= MAX_LOOSE_TOKENS ? "approximate" : "prefix";
  result.found = result.kind === "approximate";
  return result;
}

/** Corte seguro por frases, usado em resumos públicos e logs. */
export function clip(value, max) {
  const text = String(value ?? "");
  if (max <= 0) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
