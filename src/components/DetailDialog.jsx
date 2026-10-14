import { useEffect, useRef } from "react";
import ResultCard from "./ResultCard.jsx";

export default function DetailDialog({ result, onClose, showToast, onShareCard }) {
  const ref = useRef(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (result && !dialog.open) dialog.showModal();
    if (!result && dialog.open) dialog.close();
  }, [result]);

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
        <span>Checagem</span>
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
        {result ? (
          <ResultCard result={result} showToast={showToast} titleId="dialog-title" onShareCard={onShareCard} reportSource="detail" />
        ) : null}
      </div>
    </dialog>
  );
}
