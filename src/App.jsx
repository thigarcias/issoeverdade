import { useEffect, useRef, useState } from "react";
import Header from "./components/Header.jsx";
import Hero from "./components/Hero.jsx";
import Verifier from "./components/Verifier.jsx";
import Feed from "./components/Feed.jsx";
import DetailDialog from "./components/DetailDialog.jsx";
import HowItWorks from "./components/HowItWorks.jsx";
import { VERDICTS } from "./data/constants.js";
import { useToast } from "./lib/hooks.js";

const HISTORY_KEY = "iev-history-v2";

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(0, 20) : [];
  } catch {
    return [];
  }
}

export default function App() {
  const { message, show } = useToast();
  const [openResult, setOpenResult] = useState(null);
  const [history, setHistory] = useState(loadHistory);
  const [quickInput, setQuickInput] = useState(null);
  const [heroCollapsed, setHeroCollapsed] = useState(false);
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
    setHistory((h) => [result, ...h.filter((r) => r.id !== result.id)].slice(0, 20));
    show(`Pronto: nota ${result.score}/100 (${VERDICTS[result.verdict].label}).`);
  }

  function handleQuickCheck(value) {
    setHeroCollapsed(true);
    setQuickInput(value);
  }

  return (
    <>
      <Header />
      <main className="main-full">
        <Hero onQuickCheck={handleQuickCheck} collapsed={heroCollapsed} />

        <div className="wrap">
          <section className="section section-tight" id="verificar" aria-label="Verificador">
            <Verifier showToast={show} onChecked={handleChecked} quickInput={quickInput} />
          </section>

          <section className="section" id="recentes" aria-label="Suas checagens">
            <div className="section-head">
              <h2>Suas checagens</h2>
              <span className="section-count">{history.length} nesta conta local</span>
            </div>
            <p className="section-blurb">
              Tudo que você já checou neste navegador. Clique para rever cada
              afirmação com suas fontes.
            </p>
            <div style={{ marginTop: 14 }}>
              <Feed items={history} onOpen={setOpenResult} />
            </div>
          </section>

          <details className="about" id="como-funciona" ref={howRef}>
            <summary>
              Como funciona <span aria-hidden="true">＋</span>
            </summary>
            <div className="about-content">
              <p>Da mídia que você manda até a nota com fontes. Simples assim:</p>
              <HowItWorks />
            </div>
          </details>

          <details className="about" id="sobre" ref={aboutRef}>
            <summary>
              Sobre este projeto <span aria-hidden="true">＋</span>
            </summary>
            <div className="about-content">
              <p>
                O <b>isso é verdade?</b> é uma fonte da verdade para a política
                do Brasil no segundo turno de 2026: qualquer pessoa cola um link, texto,
                imagem ou vídeo e recebe uma nota de 0 a 100 com cada afirmação checada
                e suas fontes.
              </p>
              <p>
                Vídeos são baixados e transcritos automaticamente; cada frase vira um
                item auditável cruzado com fontes oficiais e confiáveis.
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
          <p>segundo turno 2026 · checagem por IA com fontes citadas</p>
          <span>v1.0</span>
        </div>
      </footer>

      <DetailDialog result={openResult} onClose={() => setOpenResult(null)} showToast={show} />
      <div id="toast" role="status" className={message ? "show" : ""}>
        {message}
      </div>
    </>
  );
}
