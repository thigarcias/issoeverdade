import { useMemo, useState } from "react";
import { VERDICTS, isLegacyMethodology } from "../data/constants.js";
import { ArrowRight, History, Search } from "lucide-react";

const FILTERS = [
  { id: "all", label: "Todas" },
  ...Object.keys(VERDICTS).map((id) => ({ id, label: VERDICTS[id].label })),
  { id: "unverified", label: "Sem veredito" },
];

/** Checagens feitas neste navegador (histórico local). */
export default function Feed({ items: allItems, onOpen }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");

  const counts = useMemo(() => {
    const c = { all: allItems.length };
    for (const item of allItems) {
      const key = VERDICTS[item.verdict] ? item.verdict : "unverified";
      c[key] = (c[key] ?? 0) + 1;
    }
    return c;
  }, [allItems]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allItems.filter((item) => {
      const key = VERDICTS[item.verdict] ? item.verdict : "unverified";
      if (filter !== "all" && key !== filter) return false;
      if (!q) return true;
      const hay = `${item.title} ${item.summary} ${item.author}`.toLowerCase();
      return q.split(/\s+/).every((word) => hay.includes(word));
    });
  }, [allItems, query, filter]);

  const hasFilter = query.trim() !== "" || filter !== "all";

  if (allItems.length === 0) {
    return (
      <div className="empty history-empty">
        <span className="empty-icon"><History size={25} aria-hidden="true" /></span>
        <h3>Sua próxima dúvida começa uma checagem.</h3>
        <p>Ainda não há análises salvas neste navegador. Envie um texto, link ou mídia para começar.</p>
        <a className="btn" href="#verificar">Fazer minha primeira checagem<ArrowRight size={16} aria-hidden="true" /></a>
      </div>
    );
  }

  return (
    <div>
      <div className="search-panel">
        <div className="search-box">
          <Search size={18} aria-hidden="true" />
          <input
            type="search"
            placeholder="Buscar nas suas checagens…"
            aria-label="Buscar checagens"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="filters" role="group" aria-label="Filtrar por veredito">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {f.id !== "all" && (
              <i style={{ background: VERDICTS[f.id]?.color ?? "var(--fg-5)" }} />
            )}
            {f.label}
            <span className="count">{counts[f.id] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="results-meta">
        <p>
          {items.length} {items.length === 1 ? "checagem" : "checagens"}
          {query.trim() && <> para “{query.trim()}”</>}
        </p>
        {hasFilter && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setFilter("all");
            }}
          >
            Limpar busca
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div className="empty">
          <h3>Nada por aqui</h3>
          <p>Tente outro termo ou limpe os filtros para ver todas as checagens.</p>
        </div>
      ) : (
        <ul className="feed">
          {items.map((item) => {
            const v = VERDICTS[item.verdict];
            return (
              <li key={item.id}>
                <article
                  className="card feed-card"
                  onClick={() => onOpen(item)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onOpen(item);
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`Abrir checagem: ${item.title}`}
                >
                  <div className="feed-top">
                    <span className={`chip ${v?.tint ?? "tint-info"}`}>
                      <i /> {v?.label ?? "Sem veredito"}
                    </span>
                    {v && item.score != null && (
                      <div className="feed-score">
                        <b style={{ color: v.color }}>{item.score}</b>
                        <small>nota<br />/100</small>
                      </div>
                    )}
                    {v && item.score == null && item.verdict && (item.claims?.length ?? 0) > 0 && (
                      <div className="feed-score">
                        <small>sem nota<br />({isLegacyMethodology(item.methodologyVersion) ? "registro anterior" : "cobertura insuficiente"})</small>
                      </div>
                    )}
                  </div>
                  {v && item.score != null && (
                    <div className="score-bar" aria-hidden="true">
                      <i style={{ width: `${item.score}%`, background: v.color }} />
                    </div>
                  )}
                  <h3>{item.title}</h3>
                  <p className="excerpt">{item.summary}</p>
                  <div className="feed-bottom">
                    <span className="meta">
                      {item.claims.length} {item.claims.length === 1 ? "afirmação" : "afirmações"} · {item.sources.length} {item.sources.length === 1 ? "fonte" : "fontes"}
                    </span>
                    <span className="quiet-link">Ler checagem<ArrowRight size={15} aria-hidden="true" /></span>
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
