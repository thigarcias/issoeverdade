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
