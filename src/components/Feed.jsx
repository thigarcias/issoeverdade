import { useMemo, useState } from "react";
import { MOCK_FEED, VERDICTS } from "../data/mocks.js";
import { resolveResult } from "../lib/results.js";

const FILTERS = [
  { id: "all", label: "Todas" },
  { id: "true", label: "Verdadeiras" },
  { id: "mostly_true", label: "Maioria verdadeira" },
  { id: "mixed", label: "Mistas" },
  { id: "unproven", label: "Sem comprovação" },
  { id: "misleading", label: "Enganosas" },
  { id: "false", label: "Falsas" },
];

export default function Feed({ onOpen }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");

  const counts = useMemo(() => {
    const c = { all: MOCK_FEED.length };
    for (const item of MOCK_FEED) {
      c[item.verdict] = (c[item.verdict] ?? 0) + 1;
    }
    return c;
  }, []);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return MOCK_FEED.filter((item) => {
      if (filter !== "all" && item.verdict !== filter) return false;
      if (!q) return true;
      const hay = `${item.title} ${item.excerpt} ${item.author} ${item.category}`.toLowerCase();
      return q.split(/\s+/).every((word) => hay.includes(word));
    });
  }, [query, filter]);

  const hasFilter = query.trim() !== "" || filter !== "all";

  return (
    <div>
      <div className="search-panel">
        <div className="search-box">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="m10.5 10.5 3 3" />
          </svg>
          <input
            type="search"
            placeholder="Buscar nome, assunto ou veículo…"
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
          <h3>Nada por aqui (mock)</h3>
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
                  onClick={() => onOpen(resolveResult(item))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onOpen(resolveResult(item));
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`Abrir checagem: ${item.title}`}
                >
                  <div className="feed-top">
                    <span className={`chip ${v.tint}`}>
                      <i /> {v.label}
                    </span>
                    <div className="feed-score">
                      <b style={{ color: v.color }}>{item.score}</b>
                      <small>
                        score
                        <br />
                        /100
                      </small>
                    </div>
                  </div>
                  <div className="score-bar" aria-hidden="true">
                    <i style={{ width: `${item.score}%`, background: v.color }} />
                  </div>
                  <h3>{item.title}</h3>
                  <p className="excerpt">{item.excerpt}</p>
                  <div className="feed-bottom">
                    <span className="meta">
                      {item.category} · {item.claimsCount} afirmações · {item.sourcesCount} fontes
                    </span>
                    <span className="quiet-link">Ler checagem</span>
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
