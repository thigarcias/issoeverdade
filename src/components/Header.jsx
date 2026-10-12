import { useEffect, useState } from "react";

const LINKS = [
  { href: "#topo", label: "Checar" },
  { href: "#recentes", label: "Checagens recentes" },
  { href: "#como-funciona", label: "Como funciona" },
];

export default function Header() {
  const [open, setOpen] = useState(false);
  const [live, setLive] = useState(null);

  useEffect(() => {
    let cancelled = false;
    // Probe: GET não é POST → 405 prova que o backend existe.
    fetch("/api/verify", { method: "GET" })
      .then((r) => !cancelled && setLive(r.status === 405))
      .catch(() => !cancelled && setLive(false));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <header className="header">
      <a className="skip" href="#topo">
        Pular para a checagem rápida
      </a>
      <div className="header-inner">
        <div className="header-left">
          <a className="brand" href="#topo" aria-label="isso é verdade? — início">
            isso é verdade<span className="brand-dot">?</span>
          </a>
          {live !== null && (
            <span
              className="mock-flag"
              title={live ? "Backend conectado — checagens com IA" : "Sem backend — demonstração local"}
              style={live ? { borderColor: "#7fb08a", color: "#bfe3c7" } : undefined}
            >
              {live ? "ao vivo" : "mock"}
            </span>
          )}
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
            Checar agora
          </a>
          <button
            className="nav-toggle"
            aria-expanded={open}
            aria-label={open ? "Fechar menu" : "Abrir menu"}
            onClick={() => setOpen((v) => !v)}
          >
            <span className="nav-toggle-bar" />
            <span className="nav-toggle-bar" />
            <span className="nav-toggle-bar" />
          </button>
        </div>
      </div>
      {open && (
        <nav className="mobile-nav" aria-label="Navegação móvel">
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
