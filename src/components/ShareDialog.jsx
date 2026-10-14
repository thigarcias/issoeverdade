import { useEffect, useRef, useState } from "react";
import { buildShareText, renderShareCard, shareCardContent } from "../lib/shareCard.js";
import { VERDICTS } from "../data/constants.js";

export default function ShareDialog({ result, onClose, showToast }) {
  const ref = useRef(null);
  const [imgUrl, setImgUrl] = useState(null);
  const [blob, setBlob] = useState(null);
  const [busy, setBusy] = useState(false);
  const canShare = typeof navigator !== "undefined" && !!navigator.share;
  const content = result ? shareCardContent(result) : null;
  const verdictLabel = result?.score == null ? "sem nota ou veredito factual" : `${VERDICTS[result?.verdict]?.label ?? "Sem veredito"}, nota ${result.score} de 100`;

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

  useEffect(() => {
    if (!result) return;
    let cancelled = false;
    setBusy(true);
    setImgUrl(null);
    setBlob(null);
    renderShareCard(result)
      .then((b) => {
        if (cancelled) return;
        setBlob(b);
        setImgUrl(URL.createObjectURL(b));
      })
      .catch(() => {
        if (!cancelled) showToast("Não consegui gerar o card. Tente de novo.");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
      setImgUrl((u) => {
        if (u) URL.revokeObjectURL(u);
        return null;
      });
    };
  }, [result, showToast]);

  function download() {
    if (!blob) return;
    const a = document.createElement("a");
    a.href = imgUrl;
    a.download = result.score == null ? "isso-e-verdade-sem-nota.png" : `isso-e-verdade-nota-${result.score}.png`;
    a.click();
    showToast("Card salvo. Compartilhe onde quiser.");
  }


  async function share() {
    if (!blob) return;
    const file = new File([blob], result.score == null ? "checagem-sem-nota.png" : `nota-${result.score}.png`, { type: "image/png" });
    const data = {
      title: "isso é verdade?",
      text: buildShareText(result, location),
      files: [file],
    };
    try {
      if (navigator.canShare?.(data)) {
        await navigator.share(data);
      } else {
        await navigator.share({ title: data.title, text: data.text });
      }
    } catch (err) {
      if (err?.name !== "AbortError") {
        showToast("Não consegui abrir o compartilhamento. Baixe o card.");
      }
    }
  }

  return (
    <dialog ref={ref} aria-label="Card de compartilhamento" className="share-dialog">
      <div className="dialog-bar">
        <span>Card para compartilhar</span>
        <button className="icon-btn" aria-label="Fechar" onClick={() => ref.current?.close()}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="m3 3 10 10M13 3 3 13" />
          </svg>
        </button>
      </div>
      <div className="dialog-body share-body">
        {busy && <p className="verify-hint">Gerando seu card…</p>}
        {imgUrl && <img src={imgUrl} alt={`${content?.title ?? "Checagem"} — ${verdictLabel}. ${content?.summary ?? ""}`} className="share-preview" />}
        <div className="result-actions">
          <button className="btn primary" onClick={download} disabled={!blob}>
            Baixar PNG
          </button>
          {canShare && (
            <button className="btn" onClick={share} disabled={!blob}>
              Compartilhar
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}
