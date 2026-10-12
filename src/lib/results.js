import { MOCK_FALLBACK, MOCK_RESULTS } from "../data/mocks.js";

/** Monta o resultado completo de um card do feed (mock). */
export function resolveResult(item) {
  if (item.resultId) {
    return MOCK_RESULTS.find((r) => r.id === item.resultId) ?? MOCK_FALLBACK;
  }
  // Item sem transcrição própria: reaproveita o esqueleto do fallback
  // com título/score/veredito do card. Mock apenas.
  return {
    ...MOCK_FALLBACK,
    id: item.id,
    title: item.title,
    verdict: item.verdict,
    score: item.score,
    kind: "Checagem editorial (mock)",
    author: item.author,
    checkedAt: item.checkedAt,
    summary: item.excerpt,
    transcript: null,
  };
}
