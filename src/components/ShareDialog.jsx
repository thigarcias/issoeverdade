import { useEffect, useRef, useState } from "react";
import { buildShareText, renderShareCard, shareCardContent } from "../lib/shareCard.js";
import { VERDICTS } from "../data/constants.js";
import { copyText } from "../lib/hooks.js";

export default function ShareDialog({ result, onClose, showToast }) {
  const ref = useRef(null);
  const genRef = useRef(0);
  const urlRef = useRef(null);
  const [imgUrl, setImgUrl] = useState(null);
  const [blob, setBlob] = useState(null);
  const [status, setStatus] = useState("idle");
  const [shareError, setShareError] = useState(null);
  const [sharing, setSharing] = useState(false);
  const [retry, setRetry] = useState(0);

  const shareSupported = typeof navigator !== "undefined" && !!navigator.share;
  const content = result ? shareCardContent(result) : null;
  const verdictLabel = result?.score == null
    ? `${VERDICTS[result?.verdict]?.label ?? "Sem veredito"}, sem nota global`
    : `${VERDICTS[result?.verdict]?.label ?? "Sem veredito"}, nota ${result.score} de 100`;
  const shareText = result
    ? buildShareText(result, typeof location !== "undefined" ? location : { origin: "", pathname: "/" })
    : "";
  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(shareText)}`;

  // Arquivo só existe após a geração; testa canShare com ele quando há blob.
  // Sem blob ainda, assume compartilhável se navigator.share existe — o botão
  // primário só habilita com blob pronto e revalida no clique.
  let filesShareable = false;
  if (shareSupported && blob) {
    try {
      filesShareable = typeof navigator.canShare === "function"
        ? navigator.canShare({ files: [new File([blob], "card.png", { type: "image/png" })] })
        : false;
    } catch {
      filesShareable = false;
    }
  } else if (shareSupported && typeof navigator.canShare !== "function") {
    filesShareable = false;
  }

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
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    if (!result) {
      setImgUrl(null);
      setBlob(null);
      setStatus("idle");
      setShareError(null);
      return;
    }
    let cancelled = false;
    const myGen = ++genRef.current;
    setStatus("generating");
    setShareError(null);
    setBlob(null);
    setImgUrl(null);
    renderShareCard(result)
      .then((b) => {
        if (cancelled || myGen !== genRef.current) return;
        const url = URL.createObjectURL(b);
        urlRef.current = url;
        setBlob(b);
        setImgUrl(url);
        setStatus("ready");
      })
      .catch(() => {
        if (cancelled || myGen !== genRef.current) return;
        setStatus("gen-error");
      });
    return () => {
      cancelled = true;
    };
  }, [result, retry]);

  useEffect(() => () => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  function download() {
    if (!blob || !imgUrl) return;
    const a = document.createElement("a");
    a.href = imgUrl;
    a.download = result.score == null ? "isso-e-verdade-sem-nota.png" : `isso-e-verdade-nota-${result.score}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast("Card salvo. Compartilhe onde quiser.");
  }

  async function shareFile() {
    if (!blob || !result) return;
    const file = new File(
      [blob],
      result.score == null ? "checagem-sem-nota.png" : `nota-${result.score}.png`,
      { type: "image/png" },
    );
    const data = { title: "isso é verdade?", text: shareText, files: [file] };
    let ok = false;
    try {
      ok = navigator.canShare?.(data) ?? false;
    } catch {
      ok = false;
    }
    if (!ok) {
      setShareError("unsupported");
      return;
    }
    setSharing(true);
    setShareError(null);
    try {
      await navigator.share(data);
    } catch (err) {
      // Cancelamento é neutro: sem toast, sem fallback automático.
      if (err?.name !== "AbortError") {
        setShareError("denied");
      }
    } finally {
      setSharing(false);
    }
  }

  const generating = status === "generating";
  const ready = status === "ready" && blob;

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
        {generating && <p className="verify-hint">Gerando seu card…</p>}
        {status === "gen-error" && (
          <>
            <p className="verify-hint" role="alert">Não consegui gerar a imagem do card.</p>
            <div className="result-actions">
              <button className="btn primary" onClick={() => setRetry((n) => n + 1)}>
                Tentar de novo
              </button>
              <button className="btn" onClick={() => copyText(shareText, showToast)}>
                Copiar texto
              </button>
            </div>
          </>
        )}
        {imgUrl && <img src={imgUrl} alt={`${content?.title ?? "Checagem"} — ${verdictLabel}. ${content?.summary ?? ""}`} className="share-preview" />}
        {ready && shareSupported && filesShareable && (
          <>
            <p className="verify-hint">Escolha WhatsApp no seletor do aparelho.</p>
            <div className="result-actions">
              <button className="btn primary" onClick={shareFile} disabled={sharing}>
                {sharing ? "Abrindo…" : "Compartilhar imagem e texto"}
              </button>
              <button className="btn" onClick={download}>
                Baixar imagem
              </button>
              <button className="btn" onClick={() => copyText(shareText, showToast)}>
                Copiar texto
              </button>
            </div>
          </>
        )}
        {ready && (!shareSupported || !filesShareable) && (
          <>
            <div className="result-actions">
              <button className="btn primary" onClick={download}>
                Baixar imagem
              </button>
              <button className="btn" onClick={() => copyText(shareText, showToast)}>
                Copiar texto
              </button>
              <a className="btn" href={whatsappUrl} target="_blank" rel="noopener noreferrer">
                Abrir WhatsApp com texto
              </a>
            </div>
            <p className="verify-hint">O aparelho não compartilha arquivos pelo navegador: anexe a imagem manualmente no WhatsApp.</p>
          </>
        )}
        {shareError === "denied" && (
          <p className="verify-hint" role="alert">Compartilhamento negado pelo aparelho. Baixe a imagem ou copie o texto.</p>
        )}
      </div>
    </dialog>
  );
}
