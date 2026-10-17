import { useEffect, useId, useMemo, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Check, ChevronLeft, ChevronRight, Copy, Eye, Globe2, Link2, MapPin, MousePointer2, RefreshCw, Users, X } from "lucide-react";
import AdminSelect from "./AdminSelect.jsx";
import "../audience.css";

const DEFAULTS = { period: "7d", scope: "all", region: "", state: "", source: "", checkId: "", q: "", page: 0, from: "", to: "" };
const SOURCE_LABEL = { direct: "Direto / não identificado", whatsapp: "WhatsApp", instagram: "Instagram", facebook: "Facebook", google: "Google", youtube: "YouTube", tiktok: "TikTok", x: "X / Twitter", telegram: "Telegram", other: "Outros sites", internal: "Navegação interna" };
const REGION_LABEL = { unknown: "Não identificado", unknown_br: "Brasil · região desconhecida", international: "Exterior" };
const STATES = { AC: "Acre", AL: "Alagoas", AP: "Amapá", AM: "Amazonas", BA: "Bahia", CE: "Ceará", DF: "Distrito Federal", ES: "Espírito Santo", GO: "Goiás", MA: "Maranhão", MT: "Mato Grosso", MS: "Mato Grosso do Sul", MG: "Minas Gerais", PA: "Pará", PB: "Paraíba", PR: "Paraná", PE: "Pernambuco", PI: "Piauí", RJ: "Rio de Janeiro", RN: "Rio Grande do Norte", RS: "Rio Grande do Sul", RO: "Rondônia", RR: "Roraima", SC: "Santa Catarina", SP: "São Paulo", SE: "Sergipe", TO: "Tocantins" };
const REGIONS = ["Norte", "Nordeste", "Centro-Oeste", "Sudeste", "Sul"];
const n = (value) => Number(value ?? 0).toLocaleString("pt-BR");
const dateLabel = (date) => String(date ?? "").slice(0, 10).split("-").reverse().slice(0, 2).join("/");
const pct = (value, total) => total ? `${(Number(value) / total * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%` : "0%";

function Trend({ days }) {
  const gradientId = useId().replaceAll(":", "");
  const [active, setActive] = useState(null);
  const max = Math.max(1, ...days.map((d) => Number(d.views)));
  const x = (i) => 38 + i / Math.max(1, days.length - 1) * 820;
  const y = (value) => 180 - Number(value) / max * 145;
  const line = (field) => days.map((day, i) => `${i ? "L" : "M"}${x(i)},${y(day[field])}`).join(" ");
  const selected = active === null ? null : days[active];
  return <section className="audience-panel audience-trend">
    <div className="audience-panel-heading"><div><p className="audience-kicker">EVOLUÇÃO</p><h2>O alcance, dia a dia.</h2></div><div className="audience-legend"><span><i />Acessos</span><span><i />Visitantes estimados</span></div></div>
    {days.length ? <>
      <svg viewBox="0 0 900 218" role="img" aria-label="Acessos e visitantes estimados por dia. Consulte os valores na tabela abaixo.">
        <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#ba5234" stopOpacity=".15" /><stop offset="100%" stopColor="#ba5234" stopOpacity="0" /></linearGradient></defs>
        {[0, .5, 1].map((part) => <g key={part}><line x1="38" x2="858" y1={y(max * part)} y2={y(max * part)} stroke="#40321e18" strokeDasharray="3 5" /><text x="30" y={y(max * part) + 4} textAnchor="end">{n(Math.round(max * part))}</text></g>)}
        <path d={`${line("views")} L${x(days.length - 1)},180 L38,180 Z`} fill={`url(#${gradientId})`} />
        <path d={line("views")} fill="none" stroke="#ad492e" strokeWidth="2.5" strokeLinejoin="round" />
        <path d={line("visitors")} fill="none" stroke="#547a67" strokeWidth="2" strokeDasharray="5 4" strokeLinejoin="round" />
        {days.map((day, i) => <g key={day.date} onMouseEnter={() => setActive(i)} onMouseLeave={() => setActive(null)}><rect x={x(i) - 410 / Math.max(1, days.length)} y="20" width={820 / Math.max(1, days.length)} height="165" fill="transparent" /><circle cx={x(i)} cy={y(day.views)} r={active === i || days.length === 1 ? 4 : 0} fill="#ad492e"><title>{dateLabel(day.date)}: {n(day.views)} acessos · {n(day.visitors)} visitantes</title></circle>{(i === 0 || i === days.length - 1 || i === Math.floor(days.length / 2)) && <text x={x(i)} y="207" textAnchor="middle">{dateLabel(day.date)}</text>}</g>)}
      </svg>
      <p className="audience-trend-caption" aria-live="polite">{selected ? `${dateLabel(selected.date)} · ${n(selected.views)} acessos · ${n(selected.visitors)} visitantes estimados` : "Datas no horário de Brasília · passe pelo gráfico para explorar."}</p>
      <details className="audience-data-table"><summary>Ver valores por dia</summary><div className="audience-table-scroll"><table><thead><tr><th>Dia</th><th>Acessos</th><th>Visitantes</th><th>Aberturas de links</th></tr></thead><tbody>{days.map((day) => <tr key={day.date}><td>{dateLabel(day.date)}</td><td>{n(day.views)}</td><td>{n(day.visitors)}</td><td>{n(day.sharedViews)}</td></tr>)}</tbody></table></div></details>
    </> : <p className="audience-empty">Nenhuma data disponível neste período.</p>}
  </section>;
}

function Distribution({ title, kicker, entries, labels, total, onSelect, empty, icon: Icon }) {
  const max = Math.max(1, ...entries.map((item) => Number(item.views)));
  return <section className="audience-panel"><div className="audience-panel-heading"><div><p className="audience-kicker">{kicker}</p><h2>{title}</h2></div><Icon size={20} aria-hidden="true" /></div>
    {entries.length ? <ul className="audience-bars">{entries.map((item) => <li key={item.name}><button type="button" onClick={() => onSelect?.(item.name)} disabled={!onSelect || ["unknown", "unknown_br", "international"].includes(item.name)} aria-label={`Filtrar ${labels[item.name] ?? item.name}`}><span>{labels[item.name] ?? item.name}</span><strong>{n(item.views)} <small>{pct(item.views, total)}</small></strong><span className="audience-bar-track" aria-hidden="true"><i style={{ width: `${Number(item.views) / max * 100}%` }} /></span></button></li>)}</ul> : <p className="audience-empty">{empty}</p>}
  </section>;
}

export default function AudienceDashboard({ request, showToast }) {
  const [filters, setFilters] = useState(DEFAULTS);
  const [reload, setReload] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const query = useMemo(() => {
    const params = new URLSearchParams({ audience: "1" });
    for (const [key, value] of Object.entries(filters)) if (value !== "" && value !== undefined) params.set(key, String(value));
    return params.toString();
  }, [filters]);
  useEffect(() => {
    let current = true;
    if (filters.period === "custom" && (!filters.from || !filters.to)) return;
    const timer = setTimeout(() => {
      setLoading(true); setError("");
      request(`/api/admin?${query}`).then((value) => { if (current) setData(value); }).catch((err) => { if (current) { setData(null); setError(err.message || "Não foi possível carregar a audiência."); } }).finally(() => { if (current) setLoading(false); });
    }, 180);
    return () => { current = false; clearTimeout(timer); };
  }, [query, reload, request, filters.period, filters.from, filters.to]);
  const change = (patch) => { if (patch.period === "custom" && (!filters.from || !filters.to)) { setData(null); setLoading(false); } else setLoading(true); setError(""); setFilters((value) => ({ ...value, ...patch, page: patch.page ?? 0 })); };
  const a = data?.audience;
  const s = a?.summary;
  const allRegions = a ? [...REGIONS.map((name) => a.regions.find((r) => r.name === name) ?? { name, views: 0 }), ...a.regions.filter((r) => !REGIONS.includes(r.name))] : [];
  const selectedLink = filters.checkId ? a?.links?.find((link) => link.id === filters.checkId) : null;
  const copy = async (id) => { try { await navigator.clipboard.writeText(`${location.origin}/?check=${encodeURIComponent(id)}`); setCopied(id); showToast?.("Link copiado."); } catch { showToast?.("Não foi possível copiar o link."); } };
  const cards = s ? [
    { icon: Eye, label: "Acessos", value: s.views, note: "Páginas efetivamente abertas" },
    { icon: Users, label: "Visitantes estimados", value: s.visitors, note: "Navegadores distintos no período" },
    { icon: Link2, label: "Aberturas de links", value: s.sharedViews, note: `${n(s.reachedLinks)} links receberam visitas` },
    { icon: MapPin, label: "Acessos do Brasil", value: s.brazilViews, note: `${pct(s.brazilViews, s.views)} dos acessos são do Brasil` },
  ] : [];
  return <section className="audience-dashboard" aria-labelledby="audience-title" aria-busy={loading}>
    <div className="audience-heading"><div><p className="admin-eyebrow">AUDIÊNCIA · DISTRIBUIÇÃO · ALCANCE</p><h1 id="audience-title">Até onde a checagem chega.</h1><p>Entenda como os links circulam, de onde vêm os acessos e o que acontece depois.</p></div><button className="btn ghost" type="button" onClick={() => setReload((v) => v + 1)} disabled={loading}><RefreshCw size={15} className={loading ? "admin-spinning" : undefined} />Atualizar</button></div>
    <div className="audience-filters" role="group" aria-label="Filtros de audiência">
      <label>Período<AdminSelect value={filters.period} onValueChange={(period) => change({ period })}><option value="today">Hoje</option><option value="7d">Últimos 7 dias</option><option value="30d">Últimos 30 dias</option><option value="90d">Últimos 90 dias</option><option value="custom">Personalizado</option></AdminSelect></label>
      {filters.period === "custom" && <><label>De<input type="date" value={filters.from} onChange={(e) => change({ from: e.target.value })} /></label><label>Até<input type="date" value={filters.to} min={filters.from} onChange={(e) => change({ to: e.target.value })} /></label></>}
      <label>Visualização<AdminSelect value={filters.scope} onValueChange={(scope) => change({ scope, checkId: "" })}><option value="all">Todo o site</option><option value="shared">Links compartilhados</option></AdminSelect></label>
      <label>Região<AdminSelect value={filters.region || "all"} onValueChange={(value) => change({ region: value === "all" ? "" : value, state: "" })}><option value="all">Todas as regiões</option>{REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}</AdminSelect></label>
      <label>Estado<AdminSelect value={filters.state || "all"} onValueChange={(value) => change({ state: value === "all" ? "" : value, region: "" })}><option value="all">Todos os estados</option>{Object.entries(STATES).map(([uf, name]) => <option key={uf} value={uf}>{uf} · {name}</option>)}</AdminSelect></label>
      <label>Origem<AdminSelect value={filters.source || "all"} onValueChange={(value) => change({ source: value === "all" ? "" : value })}><option value="all">Todas as origens</option>{Object.entries(SOURCE_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</AdminSelect></label>
      {JSON.stringify(filters) !== JSON.stringify(DEFAULTS) && <button className="btn ghost" type="button" onClick={() => { setData(null); setFilters(DEFAULTS); }}>Limpar filtros</button>}
    </div>
    {filters.checkId && <div className="audience-selected"><Link2 size={16} /><div><small>DETALHAMENTO DO LINK</small><strong>{selectedLink?.title ?? filters.checkId}</strong></div><button className="icon-btn" type="button" aria-label="Voltar a todos os links" onClick={() => change({ checkId: "" })}><X size={18} /></button></div>}
    {error && <div className="admin-error-state" role="alert"><p>{error}</p><button className="btn" onClick={() => setReload((v) => v + 1)}>Tentar novamente</button></div>}
    {data?.unavailable && <p className="admin-notice">{data.unavailable}</p>}
    {data?.enabled === false && <p className="admin-notice">A coleta está desativada. Os números abaixo mostram apenas dados já registrados.</p>}
    {filters.period === "custom" && (!filters.from || !filters.to) && <p className="admin-notice">Escolha as duas datas para consultar um período de até 90 dias.</p>}
    {loading && !a && <div className="audience-skeleton" role="status" aria-label="Carregando audiência"><span /><span /><span /><span /></div>}
    {loading && a && <p className="audience-refreshing" role="status">Atualizando audiência…</p>}
    {a && <>
      <div className="audience-kpis">{cards.map(({ icon: Icon, label, value, note }) => <article key={label}><div><span>{label}</span><Icon size={17} aria-hidden="true" /></div><strong>{n(value)}</strong><p>{note}</p></article>)}</div>
      {!s.views && <div className="audience-first-visit"><Globe2 size={25} /><div><b>Pronto para receber as primeiras visitas.</b><p>Nenhum acesso registrado com estes filtros. Os links já publicados também passam a contar novas aberturas.</p></div></div>}
      <Trend days={a.daily ?? []} />
      <div className="audience-geography"><Distribution title="De que região vem?" kicker="BRASIL & EXTERIOR" entries={allRegions} labels={REGION_LABEL} total={s.views} onSelect={(region) => change({ region, state: "" })} empty="A distribuição aparece quando houver acessos." icon={Globe2} /><Distribution title="Estado por estado." kicker="LOCALIZAÇÃO APROXIMADA" entries={a.states ?? []} labels={{ ...STATES, unknown: "Estado não identificado" }} total={s.brazilViews} onSelect={(state) => change({ state, region: "" })} empty="Ainda não há acessos identificados no Brasil." icon={MapPin} /></div>
      <div className="audience-bottom-grid"><Distribution title="Como chegaram aqui?" kicker="ORIGEM DOS ACESSOS" entries={a.sources ?? []} labels={SOURCE_LABEL} total={s.views} onSelect={(source) => change({ source })} empty="As origens aparecem após as primeiras visitas." icon={ArrowDownLeft} />
        <section className="audience-panel audience-conversion"><div className="audience-panel-heading"><div><p className="audience-kicker">DO LINK À PRÓXIMA CHECAGEM</p><h2>O alcance vira ação?</h2></div><MousePointer2 size={20} /></div><ol><li><span>Visitantes dos links</span><b>{n(s.sharedVisitors)}</b></li><li><span>Clicaram em “Fazer uma checagem”</span><b>{n(s.clicks)}</b></li><li><span>Concluíram uma nova checagem</span><b>{n(s.conversions)}</b></li></ol><div className="audience-conversion-rate"><strong>{pct(s.clicks, s.sharedVisitors)}</strong><span>dos visitantes dos links iniciaram o caminho para uma nova checagem.</span></div><p className="admin-mut">Atribuição de até 30 minutos após a abertura. {n(s.publishedLinks)} novos links publicados no site no período; acessos podem ser de links mais antigos.</p></section>
      </div>
      <section className="audience-panel audience-links"><div className="audience-panel-heading"><div><p className="audience-kicker">LINKS COMPARTILHADOS</p><h2>Cada link, seu alcance.</h2><p>Ordenados por acessos no período · inclui links ainda sem visitas.</p></div><label className="audience-search"><span className="sr-only">Buscar link por título ou ID</span><input type="search" placeholder="Buscar título ou ID…" maxLength={100} value={filters.q} onChange={(e) => change({ q: e.target.value })} /></label></div>
        <div className="audience-table-scroll"><table><thead><tr><th>Checagem publicada</th><th>Acessos</th><th>Visitantes</th><th>Cliques</th><th>Última visita</th><th><span className="sr-only">Ações</span></th></tr></thead><tbody>{a.links.map((link) => <tr key={link.id}><td><button className="audience-link-title" type="button" onClick={() => change({ checkId: link.id, scope: "shared", q: "" })}>{link.title}<ArrowUpRight size={14} /></button><small>{link.id} · publicado {dateLabel(link.published_at)}</small></td><td data-label="Acessos" className="audience-number">{n(link.views)}</td><td data-label="Visitantes">{n(link.visitors)}</td><td data-label="Cliques">{n(link.clicks)}</td><td data-label="Última visita">{link.last_view ? new Date(link.last_view).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "Sem visitas"}</td><td><button className="icon-btn" aria-label={`Copiar link de ${link.title}`} onClick={() => copy(link.id)}>{copied === link.id ? <Check size={16} /> : <Copy size={16} />}</button></td></tr>)}</tbody></table></div>
        {!a.links.length && <p className="audience-empty">Nenhum link publicado corresponde à busca.</p>}
        <div className="audience-pagination"><span>{n(a.linkTotal)} links publicados{filters.q ? " encontrados" : ""}</span><div><button className="btn ghost" disabled={filters.page === 0 || loading} aria-label="Página anterior" onClick={() => change({ page: filters.page - 1 })}><ChevronLeft size={15} /></button><span>Página {filters.page + 1}</span><button className="btn ghost" disabled={(filters.page + 1) * 15 >= a.linkTotal || loading} aria-label="Próxima página" onClick={() => change({ page: filters.page + 1 })}><ChevronRight size={15} /></button></div></div>
      </section>
      <div className="audience-method"><p><b>Como contamos.</b> Uma abertura visível no navegador conta como acesso. Recarregar a página gera outro acesso; o mesmo navegador conta uma vez no período enquanto seu identificador de 30 dias for válido. Visitantes são estimativas, não pessoas identificadas. Pré-visualizações e robôs conhecidos são filtrados.</p><p>A localização vem da hospedagem e pode ser imprecisa por VPN ou rede móvel. {n(s.unknownLocation)} acessos sem localização completa. WhatsApp e outros aplicativos nem sempre informam a origem; nesses casos aparece “Direto / não identificado”. Não coletamos GPS nem gravamos o IP bruto. Dados de até 90 dias · horário de Brasília{a.trackingSince ? ` · registros desde ${new Date(a.trackingSince).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}` : " · a coleta começa com as próximas visitas"}.</p></div>
    </>}
  </section>;
}
