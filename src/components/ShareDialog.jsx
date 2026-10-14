import { useEffect, useMemo, useRef, useState } from "react";
import { buildShareText, renderShareCards } from "../lib/shareCard.js";
import { copyText } from "../lib/hooks.js";

function cardFilename(result, page, pageCount) {
  const name = result.score == null ? "isso-e-verdade-sem-nota" : `isso-e-verdade-nota-${result.score}`;
  return `${name}${pageCount > 1 ? `-pagina-${page + 1}-de-${pageCount}` : ""}.png`;
}

export default function ShareDialog({ result, onClose, showToast }) {
  const ref = useRef(null);
  const genRef = useRef(0);
  const [cards, setCards] = useState(null);
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState("idle");
  const [imageError, setImageError] = useState(null);
  const [shareError, setShareError] = useState(null);
  const [sharing, setSharing] = useState(false);
  const [retry, setRetry] = useState(0);

  const shareSupported = typeof navigator !== "undefined" && !!navigator.share;
  const shareText = result
    ? buildShareText(result, typeof location !== "undefined" ? location : { origin: "", pathname: "/" })
    : "";
  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(shareText)}`;

  const generating = status === "generating";
  const ready = status === "ready" && cards?.result === result && cards?.retry === retry;
  const pageCount = ready ? cards.blobs.length : 0;
  const imgUrl = ready ? cards.urls[page] : null;
  const files = useMemo(() => {
    if (!ready) return [];
    return cards.blobs.map((blob, index) => new File(
      [blob],
      cardFilename(result, index, cards.blobs.length),
      { type: "image/png" },
    ));
  }, [cards, result, ready]);
  let filesShareable = false;
  if (shareSupported && files.length) {
    try {
      filesShareable = navigator.canShare?.({ files }) ?? false;
    } catch {
      filesShareable = false;
    }
  }
  const manualShare = ready && (!filesShareable || shareError === "unsupported" || shareError === "denied");

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
    const myGen = ++genRef.current;
    let cancelled = false;
    const urls = [];
    setCards(null);
    setPage(0);
    setSharing(false);
    setShareError(null);
    setImageError(null);
    setStatus(result ? "generating" : "idle");
    if (result) {
      renderShareCards(result)
        .then((blobs) => {
          if (cancelled || myGen !== genRef.current) return;
          if (!blobs.length) throw new Error("Não consegui gerar os cards. Copie o texto da checagem.");
          for (const blob of blobs) urls.push(URL.createObjectURL(blob));
          setCards({ result, retry, blobs, urls });
          setStatus("ready");
        })
        .catch((error) => {
          if (cancelled || myGen !== genRef.current) return;
          for (const url of urls) URL.revokeObjectURL(url);
          urls.length = 0;
          setImageError(error?.message || "Não consegui gerar os cards. Copie o texto da checagem.");
          setStatus("gen-error");
        });
    }
    return () => {
      cancelled = true;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [result, retry]);

  function download() {
    if (!ready || !imgUrl) return;
    const a = document.createElement("a");
    a.href = imgUrl;
    a.download = cardFilename(result, page, pageCount);
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast(pageCount > 1 ? `Página ${page + 1} de ${pageCount} salva.` : "Card salvo. Compartilhe onde quiser.");
  }

  async function shareFile() {
    if (!ready || !files.length || sharing) return;
    const myGen = genRef.current;
    const data = { title: "isso é verdade?", text: shareText, files };
    let ok = false;
    try {
      ok = shareSupported && (navigator.canShare?.(data) ?? false);
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
      if (myGen === genRef.current && err?.name !== "AbortError") {
        setShareError("denied");
      }
    } finally {
      if (myGen === genRef.current) setSharing(false);
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
        {generating && <p className="verify-hint" role="status">Gerando seu parecer…</p>}
        {status === "gen-error" && (
          <>
            <p className="verify-hint" role="alert">{imageError}</p>
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
        {imgUrl && (
          <>
            <img
              src={imgUrl}
              alt={`Parecer da checagem com pontos e notas${pageCount > 1 ? `, página ${page + 1} de ${pageCount}` : ""}. Justificativas e fontes completas estão no resultado e no texto para copiar.`}
              className="share-preview"
              width="1080"
              height="1920"
            />
            {pageCount > 1 && (
              <nav className="share-pagination" aria-label="Páginas do parecer">
                <button className="btn" onClick={() => setPage((n) => Math.max(0, n - 1))} disabled={page === 0} aria-label="Página anterior">
                  Anterior
                </button>
                <span aria-live="polite" aria-atomic="true">{page + 1} / {pageCount}</span>
                <button className="btn" onClick={() => setPage((n) => Math.min(pageCount - 1, n + 1))} disabled={page === pageCount - 1} aria-label="Próxima página">
                  Próxima
                </button>
              </nav>
            )}
            <p className="verify-hint">
              Parecer compacto em {pageCount > 1 ? `${pageCount} imagens, com todos os pontos` : "uma imagem, com todos os pontos"}.
              {" "}Justificativas e fontes completas ficam no resultado e no texto para copiar.
            </p>
          </>
        )}
        {ready && (
          <>
            {filesShareable && shareError !== "unsupported" && (
              <p className="verify-hint">
                Escolha WhatsApp no seletor do aparelho.
                {pageCount > 1 && ` O compartilhamento envia todas as ${pageCount} páginas juntas.`}
              </p>
            )}
            <div className="result-actions">
              {filesShareable && shareError !== "unsupported" && (
                <button className="btn primary" onClick={shareFile} disabled={sharing}>
                  {sharing ? "Abrindo…" : pageCount > 1 ? "Compartilhar todas as imagens e texto" : "Compartilhar imagem e texto"}
                </button>
              )}
              <button className={`btn${manualShare ? " primary" : ""}`} onClick={download}>
                {pageCount > 1 ? `Baixar página ${page + 1}` : "Baixar imagem"}
              </button>
              <button className="btn" onClick={() => copyText(shareText, showToast)}>
                Copiar texto
              </button>
              {manualShare && (
                <a className="btn" href={whatsappUrl} target="_blank" rel="noopener noreferrer">
                  Abrir WhatsApp com texto
                </a>
              )}
            </div>
            {manualShare && (
              <p className="verify-hint" role={shareError ? "alert" : undefined}>
                {shareError === "denied"
                  ? "O aparelho não concluiu o compartilhamento. "
                  : "O navegador não permite compartilhar este conjunto de arquivos. "}
                {pageCount > 1
                  ? `Navegue pelas ${pageCount} páginas, baixe cada uma e anexe todas manualmente no WhatsApp.`
                  : "Baixe a imagem e anexe manualmente no WhatsApp."}
                {" "}O link do WhatsApp envia apenas o texto completo, sem imagens.
              </p>
            )}
          </>
        )}
      </div>
    </dialog>
  );
}
