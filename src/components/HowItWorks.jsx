const STEPS = [
  {
    title: "Você manda o conteúdo",
    text: "Pode ser link, texto, foto, áudio ou vídeo — do Instagram, WhatsApp, YouTube ou jornal.",
  },
  {
    title: "A gente ouve e lê tudo",
    text: "Vídeo e áudio viram texto, para cada frase poder ser checada separadamente.",
  },
  {
    title: "Checamos frase por frase",
    text: "Cada parte recebe um selo: verdade, mentira, sem comprovação ou precisa de contexto.",
  },
  {
    title: "Você recebe a nota com fontes",
    text: "Nota de 0 a 100 para o conteúdo todo, sempre mostrando de onde veio cada informação.",
  },
];

export default function HowItWorks() {
  return (
    <ol className="steps">
      {STEPS.map((s, i) => (
        <li key={s.title} className="card step">
          <span className="n">{String(i + 1).padStart(2, "0")}</span>
          <h3>{s.title}</h3>
          <p>{s.text}</p>
        </li>
      ))}
    </ol>
  );
}
