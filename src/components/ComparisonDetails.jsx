const number = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 6 });
const SCOPE_LABELS = {
  whole_period: "Dados dos períodos completos",
  shorter_recorte: "Dados de um recorte mais curto",
  lower_bound: "Totais parciais usados como limite inferior",
  partial: "Dados parciais: a comparação completa não foi estabelecida",
};

export default function ComparisonDetails({ comparison }) {
  if (!comparison || !["complete", "lower_bound", "partial", "invalid"].includes(comparison.status)) return null;
  const groups = comparison.status !== "invalid" && Array.isArray(comparison.groups) ? comparison.groups : [];
  const totalLabel = `Total${comparison.unit ? ` (${comparison.unit})` : ""}`;
  const valueLabel = `Valor${comparison.unit ? ` (${comparison.unit})` : ""}`;
  return (
    <section className="comparison-details" aria-label="Dados e cálculo da comparação">
      <p><b>{SCOPE_LABELS[comparison.scope] ?? "Limites da comparação"}</b></p>
      <p className="score-legend">{[comparison.metric, comparison.region, comparison.dataset].filter(Boolean).join(" · ")}</p>
      {groups.length > 0 && (
        <table className="comparison-table">
          <thead><tr><th scope="col">Período</th><th scope="col">{totalLabel}</th><th scope="col">Anos com dados</th></tr></thead>
          <tbody>{groups.map((group, index) => (
            <tr key={index}>
              <td><span className="comparison-cell-label" aria-hidden="true">Período</span>{group.label ?? `Período ${index + 1}`}<br /><small>{group.startYear}–{group.endYear}</small></td>
              <td><span className="comparison-cell-label" aria-hidden="true">{totalLabel}</span>{group.coverage?.available > 0 && typeof group.total === "number" && Number.isFinite(group.total) ? number.format(group.total) : "Indisponível"}</td>
              <td><span className="comparison-cell-label" aria-hidden="true">Anos com dados</span>{group.coverage ? `${group.coverage.available}/${group.coverage.expected}` : "Indisponível"}{group.coverage?.complete === false ? " · parcial" : ""}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {groups.map((group, index) => Array.isArray(group.rows) && group.rows.length > 0 && (
        <div key={index}>
          <table className="comparison-table">
            <caption>Dados anuais · {group.label ?? `Período ${index + 1}`}</caption>
            <thead><tr><th scope="col">Ano</th><th scope="col">{valueLabel}</th><th scope="col">Cobertura</th></tr></thead>
            <tbody>{group.rows.map((row) => (
              <tr key={row.year}>
                <td><span className="comparison-cell-label" aria-hidden="true">Ano</span>{row.year}</td>
                <td><span className="comparison-cell-label" aria-hidden="true">{valueLabel}</span>{typeof row.value === "number" && Number.isFinite(row.value) ? number.format(row.value) : "Indisponível"}</td>
                <td><span className="comparison-cell-label" aria-hidden="true">Cobertura</span>{row.complete ? "Completa" : "Parcial"}</td>
              </tr>
            ))}</tbody>
          </table>
          {group.coverage?.missingYears?.length > 0 && (
            <p className="score-legend">Anos ausentes ou incompletos: {group.coverage.missingYears.join(", ")}.</p>
          )}
        </div>
      ))}
      {comparison.reason && <p className="score-legend">{comparison.reason}</p>}
      <p className="score-legend">Soma calculada a partir dos trechos localizados. A revisão verifica se métrica, região e períodos permitem a conclusão.</p>
    </section>
  );
}
