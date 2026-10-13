// Constantes de UI — selos, cores e textos do pipeline.
// Todo resultado de checagem vem da API real (/api/verify).

export const VERDICTS = {
  true: { label: "Verdadeiro", tint: "tint-up", color: "#2f6b44" },
  mostly_true: { label: "Maioria verdadeira", tint: "tint-up", color: "#2f6b44" },
  mixed: { label: "Misto", tint: "tint-warn", color: "#7a5b1e" },
  unproven: { label: "Sem comprovação", tint: "tint-warn", color: "#7a5b1e" },
  misleading: { label: "Enganoso", tint: "tint-down", color: "#c22a17" },
  false: { label: "Falso", tint: "tint-down", color: "#c22a17" },
};

export const CLAIM_STATUS = {
  true: { label: "Verdade", tint: "tint-up", color: "#2f6b44" },
  false: { label: "Mentira", tint: "tint-down", color: "#c22a17" },
  unproven: { label: "Sem comprovação", tint: "tint-warn", color: "#7a5b1e" },
  context: { label: "Precisa de contexto", tint: "tint-info", color: "#33608f" },
};

export const PIPELINE_STEPS = [
  {
    id: "intake",
    title: "Recebendo seu conteúdo",
    hint: "Guardamos o link, texto, foto ou vídeo.",
  },
  {
    id: "transcribe",
    title: "Ouvindo o vídeo ou áudio",
    hint: "Tudo vira texto para poder checar parte por parte.",
  },
  {
    id: "claims",
    title: "Separando cada afirmação",
    hint: "Cada frase importante vira um item da checagem.",
  },
  {
    id: "sources",
    title: "Conferindo as fontes",
    hint: "Comparamos com notícias e dados oficiais.",
  },
  {
    id: "score",
    title: "Dando a nota final",
    hint: "Nota de 0 a 100 para o conteúdo todo.",
  },
];

// Frases rotativas do "thinking" — exibidas enquanto a IA trabalha.
// Estilo das empresas de IA: curtas, progressivas, ganham tempo de leitura.
export const THINKING_LINES = [
  "Lendo o conteúdo…",
  "Entendendo o contexto…",
  "Separando as afirmações…",
  "Buscando fontes oficiais…",
  "Conferindo com o TSE…",
  "Comparando versões…",
  "Pesando as evidências…",
  "Montando o veredito…",
];
