import { useState } from "react";
import { ArrowUpRight, Menu, X } from "lucide-react";

const LINKS = [
  { href: "#topo", label: "Checar" },
  { href: "#recentes", label: "Suas checagens" },
  { href: "#como-funciona", label: "Como funciona" },
];

export default function Header() {
  const [open, setOpen] = useState(false);

  return (
    <header className="header">
      <a className="skip" href="#topo">
        Pular para a checagem rápida
      </a>
      <div className="header-inner">
        <div className="header-left">
          <div className="brand-lockup">
            <a className="brand" href="#topo" aria-label="isso é verdade? — início">isso é verdade<span className="brand-dot">?</span></a>
            <small className="brand-caption">INFORMAÇÃO COM CONTEXTO</small>
          </div>
          <nav className="site-nav" aria-label="Navegação principal">
            {LINKS.map((l) => (
              <a key={l.href} href={l.href}>
                {l.label}
              </a>
            ))}
          </nav>
        </div>
        <div className="header-actions">
          <a className="btn" href="#topo">
            Checar agora<ArrowUpRight size={16} aria-hidden="true" />
          </a>
          <button
            className="nav-toggle"
            aria-expanded={open}
            aria-label={open ? "Fechar menu" : "Abrir menu"}
            aria-controls="home-mobile-nav"
            type="button"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X size={22} aria-hidden="true" /> : <Menu size={22} aria-hidden="true" />}
          </button>
        </div>
      </div>
      {open && (
        <nav className="mobile-nav" id="home-mobile-nav" aria-label="Navegação móvel">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} onClick={() => setOpen(false)}>
              {l.label}
            </a>
          ))}
        </nav>
      )}
    </header>
  );
}
