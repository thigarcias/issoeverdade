import { useEffect, useRef, useState } from "react";
import Header from "./components/Header.jsx";
import Hero from "./components/Hero.jsx";
import Verifier from "./components/Verifier.jsx";
import Feed from "./components/Feed.jsx";
import DetailDialog from "./components/DetailDialog.jsx";
import ShareDialog from "./components/ShareDialog.jsx";
import Admin from "./components/Admin.jsx";
import HowItWorks from "./components/HowItWorks.jsx";
import { VERDICTS, migrateVerdict } from "./data/constants.js";
import { useToast } from "./lib/hooks.js";
import { ArrowUpRight, BookOpen, ChevronDown, History, LockKeyhole } from "lucide-react";
import "./home.css";
const HISTORY_KEY = "iev-history-v2";

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    // Migra registros antigos ("mixed" → nova escala) uma vez, na leitura.
    return Array.isArray(parsed)
      ? parsed.slice(0, 20).map((r) => ({ ...r, verdict: migrateVerdict(r?.verdict, r?.score) }))
      : [];
  } catch {
    return [];
  }
}

export default function App() {
  const { message, show } = useToast();
  const [openResult, setOpenResult] = useState(null);
  const [shareResult, setShareResult] = useState(null);
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
    const verdict = VERDICTS[result.verdict];
    show(verdict
      ? `Checagem concluída: ${verdict.label} · ${result.score == null ? "sem nota global" : `${result.score}/100`}.`
      : "Checagem concluída sem veredito factual.");
  }

  function handleQuickCheck(value) {
    setHeroCollapsed(true);
    setQuickInput(value);
  }

  const [isAdmin, setIsAdmin] = useState(() => location.pathname === "/admin" || location.hash.startsWith("#/admin"));
  useEffect(() => {
    function onLocation() {
      setIsAdmin(location.pathname === "/admin" || location.hash.startsWith("#/admin"));
    }
    window.addEventListener("hashchange", onLocation);
    window.addEventListener("popstate", onLocation);
    return () => {
      window.removeEventListener("hashchange", onLocation);
      window.removeEventListener("popstate", onLocation);
    };
  }, []);

  if (isAdmin) {
    return (
      <>
        <main className="main-full admin-main" id="main-content">
          <Admin showToast={show} />
        </main>
        <div id="toast" role="status" className={message ? "show" : ""}>{message}</div>
      </>
    );
  }

  return (
    <div className="home-page">
      <Header />
      <main className="main-full">
        <Hero onQuickCheck={handleQuickCheck} collapsed={heroCollapsed} />

        <div className="wrap">
          <section className="section section-tight" id="verificar" aria-label="Verificador">
            <div className="section-head">
              <div><p className="section-kicker">01 / Verificar</p><h2>O contexto faz a diferença.</h2></div>
              <p className="section-blurb">Escolha o formato e envie o material. A análise separa afirmações, evidências e o que ainda não pode ser concluído.</p>
            </div>
            <Verifier showToast={show} onChecked={handleChecked} quickInput={quickInput} onShareCard={setShareResult} />
          </section>

          <section className="section" id="recentes" aria-label="Suas checagens">
            <div className="section-head">
              <div><p className="section-kicker">02 / Seu histórico</p><h2>Suas checagens</h2></div>
              <span className="section-count"><History size={15} aria-hidden="true" />{history.length} neste navegador</span>
            </div>
            <p className="section-blurb">
              Seu histórico fica só neste navegador. Abra uma checagem para rever as afirmações, as fontes e os limites da análise.
            </p>
            <div style={{ marginTop: 14 }}>
              <Feed items={history} onOpen={setOpenResult} />
            </div>
          </section>

          <div className="home-information">
          <details className="about" id="como-funciona" ref={howRef}>
            <summary>
              <span className="about-heading">Como funciona<small>Do material enviado às evidências</small></span><ChevronDown size={20} aria-hidden="true" />
            </summary>
            <div className="about-content">
              <p>Da mídia que você manda até a nota com fontes. Simples assim:</p>
              <HowItWorks />
            </div>
          </details>

          <details className="about" id="sobre" ref={aboutRef}>
            <summary>
              <span className="about-heading">Sobre este projeto<small>Transparência sobre a ferramenta e seus limites</small></span><ChevronDown size={20} aria-hidden="true" />
            </summary>
            <div className="about-content">
              <p>
                O <b>isso é verdade?</b> é uma ferramenta automática para analisar afirmações públicas. Ela pode errar e não substitui apuração independente. Opinião, previsão, evidência insuficiente e mídia inacessível não são falsidade; quando falta base, a checagem pode não atribuir veredito.
              </p>
              <p>
                Links podem fornecer metadados, mas o URL não comprova uma afirmação. Vídeos e uploads são processados somente quando o conteúdo está acessível; amostras de áudio e imagem podem ser parciais. A nota não é probabilidade calibrada.
              </p>
            </div>
          </details>
          </div>
        </div>
      </main>

      <footer className="home-footer">
        <div className="footer-inner">
          <div className="footer-intro">
            <a className="footer-brand" href="#topo">isso é verdade<span className="brand-dot">?</span></a>
            <p>Antes de compartilhar, vale checar.</p>
          </div>
          <nav className="footer-links" aria-label="Transparência e políticas">
            <a href="/metodologia.html"><BookOpen size={15} aria-hidden="true" />Metodologia</a>
            <a href="/correcoes.html">Correções<ArrowUpRight size={15} aria-hidden="true" /></a>
            <a href="/privacidade.html"><LockKeyhole size={15} aria-hidden="true" />Privacidade</a>
          </nav>
          <p className="footer-note">Checagem automática, não apuração independente. Consulte as evidências e os limites de cada resultado.</p>
        </div>
      </footer>
      <DetailDialog result={openResult} onClose={() => setOpenResult(null)} showToast={show} onShareCard={setShareResult} />
      <ShareDialog result={shareResult} onClose={() => setShareResult(null)} showToast={show} />
      <div id="toast" role="status" className={message ? "show" : ""}>
        {message}
      </div>
    </div>
  );
}
