export default function ScoreRing({ score, color, label = "Score da verdade", title }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const filled = Math.max(0, Math.min(100, score)) / 100;

  return (
    <div className="score-holder" role="img" aria-label={`${label}: ${score} de 100`} title={title ?? `${label}: ${score} de 100`}>
      <svg className="score-ring" viewBox="0 0 84 84" aria-hidden="true">
        <circle className="track" cx="42" cy="42" r={r} />
        <circle
          className="bar"
          cx="42"
          cy="42"
          r={r}
          stroke={color}
          strokeDasharray={`${filled * c} ${c}`}
        />
      </svg>
      <span className="score-value">{score}</span>
    </div>
  );
}
