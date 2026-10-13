import { useState } from "react";

/**
 * Tela cheia (100vh): título + campo. Ao submeter, App colapsa para a barra
 * compacta (classe `hero-collapsed` no main) com transição de altura/fade.
 */
export default function Hero({ onQuickCheck, collapsed }) {
  const [quick, setQuick] = useState("");

  function submit(e) {
    e.preventDefault();
    const value = quick.trim();
    if (value.length < 4) return;
    onQuickCheck?.(value);
  }

  return (
    <section
      className={`hero-full${collapsed ? " hero-collapsed" : ""}`}
      id="topo"
      aria-label="Verificação rápida"
    >
      <div className="wrap hero-full-inner">
        <p className="hero-kick">
          <span className="hero-kick-red">Eleições 2026</span>
          <span className="sep" aria-hidden="true">
            /
          </span>
          <span>Segundo turno</span>
        </p>
        <h1 className="quick-title">
          Isso é verdade<span className="dot">?</span>
        </h1>
        <p className="quick-sub">
          Cole um link, texto ou envie mídia. A checagem mostra o que as evidências sustentam — e quando não há base suficiente para concluir.
        </p>
        <form className="quick-form" onSubmit={submit} role="search" aria-label="Checagem rápida">
          <div className="input-box quick-input">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-1 1M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l1-1" />
            </svg>
            <input
              type="text"
              inputMode="url"
              placeholder="Cole aqui o link, o texto ou a notícia…"
              aria-label="Cole aqui o link, o texto ou a notícia"
              value={quick}
              onChange={(e) => setQuick(e.target.value)}
              autoComplete="off"
            />
          </div>
          <button className="btn primary big" type="submit" disabled={quick.trim().length < 4}>
            Checar
          </button>
        </form>
        <p className="quick-note">
          Grátis, sem conta, em segundos.{" "}
          <a href="#como-funciona">Como funciona?</a>
        </p>
        <a className="hero-scroll" href="#verificar" aria-label="Rolar para o verificador completo">
          <span aria-hidden="true">↓</span> ou use o verificador completo
        </a>
      </div>
    </section>
  );
}
