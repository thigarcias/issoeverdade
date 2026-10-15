const STEPS = [
  {
    title: "Você envia o material",
    text: "Pode ser link, texto, imagem ou vídeo. Só analisamos conteúdo que o sistema consiga acessar e processar.",
  },
  {
    title: "Lemos o que está disponível",
    text: "Áudio pode ser transcrito e quadros podem ser amostrados; isso não garante cobertura integral do vídeo nem autenticidade da imagem.",
  },
  {
    title: "Relacionamos afirmações e evidências",
    text: "Cada afirmação verificável é comparada com evidências vinculadas. Uma fonte sobre o mesmo tema não basta para comprová-la.",
  },
  {
    title: "Você recebe resultado e limites",
    text: "O resultado pode ser verdadeiro, maioria verdadeira, parcialmente verdadeiro, distorcido, enganoso, falso ou sem comprovação — e às vezes não há base para um veredito. A nota não é probabilidade calibrada.",
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
