import { useEffect, useRef, useState } from "react";

export function useToast() {
  const [message, setMessage] = useState(null);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  function show(msg) {
    setMessage(msg);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), 2600);
  }

  return { message, show };
}

export async function copyText(text, show) {
  try {
    await navigator.clipboard.writeText(text);
    show("Link copiado. Compartilhe com a fonte citada.");
  } catch {
    show("Não foi possível copiar. Selecione e copie manualmente.");
  }
}

export const DEFAULT_LIMITS = {
  maxUploadBytes: 3 * 1024 * 1024,
  maxTextChars: 8000,
  maxMediaSeconds: 900,
};

/**
 * Limites publicados por /api/health: a interface mostra exatamente os tetos que
 * o servidor aplica. O padrão local vale apenas antes da resposta.
 */
export function useServerLimits() {
  const [limits, setLimits] = useState(DEFAULT_LIMITS);
  useEffect(() => {
    let active = true;
    fetch("/api/health")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!active || !data?.limits) return;
        setLimits({
          maxUploadBytes: Number(data.limits.maxUploadBytes) || DEFAULT_LIMITS.maxUploadBytes,
          maxTextChars: Number(data.limits.maxTextChars) || DEFAULT_LIMITS.maxTextChars,
          maxMediaSeconds: Number(data.limits.maxMediaSeconds) || DEFAULT_LIMITS.maxMediaSeconds,
        });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return limits;
}
