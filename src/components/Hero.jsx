import { useState } from "react";
import { ArrowDown, ArrowRight, Link2 } from "lucide-react";

export default function Hero({ onQuickCheck, collapsed }) {
  const [quick, setQuick] = useState("");

  function submit(e) {
    e.preventDefault();
    const value = quick.trim();
    if (value.length < 4) return;
    onQuickCheck?.(value);
  }

  return (
    <section className={`hero-full${collapsed ? " hero-collapsed" : ""}`} id="topo" aria-label="Verificação rápida">
      <div className="wrap hero-full-inner">
        <p className="hero-kick"><span className="hero-kick-red">Eleições 2026</span><span className="sep" aria-hidden="true">/</span><span>Segundo turno</span></p>
        <h1 className="quick-title">Isso é verdade<span className="dot">?</span></h1>
        <p className="quick-sub">Digite ou cole um texto ou link, ou envie mídia no verificador completo. A checagem mostra o que as evidências sustentam — e quando não há base suficiente para concluir.</p>
        <form className="quick-form" onSubmit={submit} role="search" aria-label="Checagem rápida">
          <div className="input-box quick-input">
            <Link2 size={19} aria-hidden="true" />
            <input id="quick-check-input" type="text" inputMode="text" placeholder="Digite ou cole um texto ou link…" aria-label="Digite ou cole um texto ou link para checar" value={quick} onChange={(e) => setQuick(e.target.value)} autoComplete="off" />
          </div>
          <button className="btn primary big" type="submit" disabled={quick.trim().length < 4}>Checar<ArrowRight size={17} aria-hidden="true" /></button>
        </form>
        <p className="quick-note">Grátis e sem conta. <a href="#como-funciona">Como funciona?</a></p>
        <a className="hero-scroll" href="#verificar"><ArrowDown size={15} aria-hidden="true" />Ou use o verificador completo</a>
      </div>
    </section>
  );
}
