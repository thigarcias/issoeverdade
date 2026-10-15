import { useEffect, useRef } from "react";
import ResultCard from "./ResultCard.jsx";

export default function DetailDialog({ result, state, onRetry, onClose, showToast, onShareCard }) {
  const ref = useRef(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if ((result || state) && !dialog.open) dialog.showModal();
    if (!result && !state && dialog.open) dialog.close();
  }, [result, state]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    function handleClose() {
      onClose();
    }
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, [onClose]);

  return (
    <dialog ref={ref} aria-labelledby="dialog-title">
      <div className="dialog-bar">
        <span id="dialog-title">{state || result?.publicView ? "Checagem compartilhada" : "Checagem"}</span>
        <button
          className="icon-btn"
          aria-label="Fechar"
          onClick={() => ref.current?.close()}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="m3 3 10 10M13 3 3 13" />
          </svg>
        </button>
      </div>
      <div className="dialog-body">
        {state?.status === "loading" && <p className="verify-hint" role="status">Carregando checagem publicada…</p>}
        {state && state.status !== "loading" && (
          <section className="shared-check-state" role="alert">
            <h2>{state.status === "not-found" ? "Checagem não encontrada" : "Serviço indisponível"}</h2>
            <p>{state.message}</p>
            {state.status === "not-found" && <p>O link pode estar incorreto ou a checagem pode não ter sido publicada. Somente resultados publicados podem ser abertos por aqui.</p>}
            <button className="btn" type="button" onClick={onRetry}>Tentar novamente</button>
          </section>
        )}
        {result?.publicView && <p className="verify-hint">Resultado público · checagem realizada em {result.checkedAt}. Esta visualização não permite publicar ou acessar registros privados.</p>}
        {result ? (
          <ResultCard result={result} showToast={showToast} titleId="dialog-result-title" onShareCard={onShareCard} reportSource="detail" />
        ) : null}
      </div>
    </dialog>
  );
}
