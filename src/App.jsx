import { useEffect, useRef, useState } from "react";
import Header from "./components/Header.jsx";
import Hero from "./components/Hero.jsx";
import Verifier from "./components/Verifier.jsx";
import Feed from "./components/Feed.jsx";
import DetailDialog from "./components/DetailDialog.jsx";
import HowItWorks from "./components/HowItWorks.jsx";
import { MOCK_FEED, VERDICTS } from "./data/mocks.js";
import { useToast } from "./lib/hooks.js";

const HISTORY_KEY = "iev-history-v1";

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(0, 6) : [];
  } catch {
    return [];
  }
}

export default function App() {
  const { message, show } = useToast();
  const [openResult, setOpenResult] = useState(null);
  const [history, setHistory] = useState(loadHistory);
  const [quickInput, setQuickInput] = useState(null);
  const aboutRef = useRef(null);
  const howRef = useRef(null);

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch {
      // Armazenamento indisponível: histórico segue volátil na sessão.
    }
  }, [history]);

  useEffect(() => {
    function openDetailsOnHash() {
      if (location.hash === "#sobre") aboutRef.current?.setAttribute("open", "");
      if (location.hash === "#como-funciona") howRef.current?.setAttribute("open", "");
    }
    openDetailsOnHash();
    window.addEventListener("hashchange", openDetailsOnHash);
    return () => window.removeEventListener("hashchange", openDetailsOnHash);
  }, []);

  function handleChecked(result) {
    setHistory((h) => [result, ...h.filter((r) => r.id !== result.id)].slice(0, 6));
    show(`Checagem pronta: score ${result.score}/100 (${VERDICTS[result.verdict].label}).`);
  }

  return (
    <>
      <Header />
      <main className="main-full">
        <Hero onQuickCheck={setQuickInput} />

        <div className="wrap">
          <section className="section section-tight" id="verificar" aria-label="Verificador">
            <Verifier showToast={show} onChecked={handleChecked} quickInput={quickInput} />


            {history.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <h3 className="sec-label">Suas checagens</h3>
                <div className="history">
                  {history.map((r) => (
                    <button key={r.id} type="button" onClick={() => setOpenResult(r)}>
                      <span className={`chip ${VERDICTS[r.verdict].tint}`}>
                        <i /> {r.score}/100 · {VERDICTS[r.verdict].label}
                      </span>
                      <b>{r.title}</b>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className="section" id="recentes" aria-label="Checagens recentes">
            <div className="section-head">
              <h2>Checagens recentes do segundo turno</h2>
              <span className="section-count">{MOCK_FEED.length} mocks</span>
            </div>
            <p className="section-blurb">
              O que já passou pelo verificador. Busque por nome, assunto ou veículo e
              clique para ver afirmação por afirmação, com fontes.
            </p>
            <div style={{ marginTop: 14 }}>
              <Feed onOpen={setOpenResult} />
            </div>
          </section>

          <details className="about" id="como-funciona" ref={howRef}>
            <summary>
              Como funciona <span aria-hidden="true">＋</span>
            </summary>
            <div className="about-content">
              <p>Da mídia que você manda até o score com fontes. Simples assim:</p>
              <HowItWorks />
            </div>
          </details>

          <details className="about" id="sobre" ref={aboutRef}>
            <summary>
              Sobre este projeto <span aria-hidden="true">＋</span>
            </summary>
            <div className="about-content">
              <p>
                O <b>isso é verdade?</b> quer ser uma fonte da verdade para a política
                do Brasil no segundo turno de 2026: qualquer pessoa cola um link, texto,
                imagem ou vídeo e recebe um score da verdade com cada afirmação checada
                e suas fontes.
              </p>
              <p>
                O plano técnico: transcrição com o modelo Whisper Turbo e validação por
                modelos via OpenCode API. Por enquanto esta é a versão de design e
                funcionamento com <b>dados 100% mockados</b> — nenhum score, transcrição
                ou fonte exibida aqui é real.
              </p>
              <p>
                Design inspirado em <a href="https://bolsomaster.site/">bolsomaster.site</a>:
                paleta creme + tinta + vermelho, serifada Faustina nos títulos e cartões
                com sombra dura.
              </p>
            </div>
          </details>
        </div>
      </main>

      <footer>
        <div className="footer-inner">
          <span className="footer-brand">
            isso é verdade<span className="brand-dot">?</span>
          </span>
          <p>Protótipo com dados mockados · segundo turno 2026 · nada aqui é uma checagem real</p>
          <span>mock · v0.1</span>
        </div>
      </footer>

      <DetailDialog result={openResult} onClose={() => setOpenResult(null)} showToast={show} />
      <div id="toast" role="status" className={message ? "show" : ""}>
        {message}
      </div>
    </>
  );
}
