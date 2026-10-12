// ---------------------------------------------------------------------------
// MOCK LAYER — dados fictícios para desenvolvimento local.
// Trocar por chamadas reais (Whisper + OpenCode) em `src/lib/api.js`.
// Nenhum texto aqui afirma fato real: títulos marcados como [MOCK].
// ---------------------------------------------------------------------------

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

export const MOCK_RESULTS = [
  {
    id: "mock-nicolas-video",
    match: ["nicolas", "nicolás", "ferreira", "instagram.com/reel", "deputado"],
    verdict: "mixed",
    score: 62,
    title: "[MOCK] Vídeo: deputado fala sobre segundo turno no Instagram",
    kind: "Vídeo · Instagram (mock)",
    author: "Deputado N. F. (mock)",
    publishedAt: "10/10/2026",
    checkedAt: "há 2 min",
    summary:
      "Das 4 afirmações checáveis, 2 se sustentam em fontes oficiais, 1 está sem comprovação e 1 contradiz os dados públicos consultados. O score reflete o peso de cada trecho na duração do vídeo.",
    claims: [
      {
        id: "c1",
        status: "true",
        score: 96,
        text: "“O segundo turno acontece no último domingo de outubro.”",
        note: "Calendário oficial confirma a data.",
        sourceIds: [0, 1],
      },
      {
        id: "c2",
        status: "true",
        score: 93,
        text: "“O voto é obrigatório para maiores de 18 anos.”",
        note: "Regra geral confirmada, com exceções previstas em lei.",
        sourceIds: [1],
      },
      {
        id: "c3",
        status: "unproven",
        score: 45,
        text: "“Milhões de eleitores tiveram o título cancelado este mês.”",
        note: "Nenhum balanço oficial com esse número foi localizado.",
        sourceIds: [],
      },
      {
        id: "c4",
        status: "false",
        score: 8,
        text: "“A apuração oficial demora mais de uma semana.”",
        note: "Histórico de apurações mostra totalização no mesmo dia.",
        sourceIds: [2, 3],
      },
    ],
    transcript: [
      { ts: "00:00", text: "Pessoal, gravo esse vídeo porque o segundo turno está chegando.", mark: null },
      { ts: "00:07", text: "O segundo turno acontece no último domingo de outubro.", mark: "true" },
      { ts: "00:14", text: "Lembrando que o voto é obrigatório para maiores de 18 anos.", mark: "true" },
      { ts: "00:21", text: "Milhões de eleitores tiveram o título cancelado este mês.", mark: "unproven" },
      { ts: "00:29", text: "E a apuração oficial demora mais de uma semana.", mark: "false" },
    ],
    sources: [
      { outlet: "TSE — Calendário eleitoral 2026", detail: "Página oficial · mock", url: "#" },
      { outlet: "TSE — Perguntas frequentes do eleitor", detail: "Página oficial · mock", url: "#" },
      { outlet: "Agência Brasil — Histórico de apurações", detail: "Reportagem · mock", url: "#" },
      { outlet: "Aos Fatos — Checagem relacionada", detail: "Agência de checagem · mock", url: "#" },
    ],
  },
  {
    id: "mock-urna-audio",
    match: ["urna", "fraude", "audio", "áudio", "whatsapp", "zap"],
    verdict: "false",
    score: 12,
    title: "[MOCK] Áudio de WhatsApp sobre urnas eletrônicas",
    kind: "Áudio · WhatsApp (mock)",
    author: "Encaminhado (mock)",
    publishedAt: "09/10/2026",
    checkedAt: "há 26 min",
    summary:
      "As 3 afirmações centrais do áudio repetem boatos já desmentidos por auditorias públicas e testes oficiais. Nenhuma fonte sustenta o conteúdo; todas as fontes consultadas o contradizem.",
    claims: [
      {
        id: "c1",
        status: "false",
        score: 5,
        text: "“As urnas transmitem votos pela internet durante a votação.”",
        note: "Urnas não têm conexão de rede; transmissão usa mídia física.",
        sourceIds: [0, 2],
      },
      {
        id: "c2",
        status: "false",
        score: 11,
        text: "“Nenhum teste público acontece antes da eleição.”",
        note: "Testes públicos de segurança são documentados e abertos.",
        sourceIds: [1],
      },
      {
        id: "c3",
        status: "false",
        score: 18,
        text: "“Os boletins de urna são secretos.”",
        note: "Boletins são afixados na seção e publicados online.",
        sourceIds: [0, 2],
      },
    ],
    transcript: [
      { ts: "00:00", text: "Repassando aqui o que me mandaram sobre as urnas…", mark: null },
      { ts: "00:04", text: "As urnas transmitem votos pela internet durante a votação.", mark: "false" },
      { ts: "00:11", text: "Nenhum teste público acontece antes da eleição.", mark: "false" },
      { ts: "00:18", text: "E os boletins de urna são secretos, ninguém vê.", mark: "false" },
    ],
    sources: [
      { outlet: "TSE — Segurança da urna eletrônica", detail: "Página oficial · mock", url: "#" },
      { outlet: "TSE — Teste público de segurança", detail: "Relatório oficial · mock", url: "#" },
      { outlet: "Lupa — Checagem sobre boletins de urna", detail: "Agência de checagem · mock", url: "#" },
    ],
  },
  {
    id: "mock-pesquisa-link",
    match: ["pesquisa", "poll", "datafolha", "ibope", "quaest", "intenção", "voto"],
    verdict: "mostly_true",
    score: 84,
    title: "[MOCK] Post sobre pesquisa de intenção de voto",
    kind: "Link · Rede social (mock)",
    author: "@eleitor_mock",
    publishedAt: "11/10/2026",
    checkedAt: "há 1 h",
    summary:
      "Os números citados batem com a pesquisa registrada no TSE dentro da margem de erro. Só o comentário sobre “virada garantida” extrapola o que os dados permitem afirmar.",
    claims: [
      {
        id: "c1",
        status: "true",
        score: 95,
        text: "“A pesquisa ouviu 2.000 eleitores em 120 municípios.”",
        note: "Metodologia idêntica ao registro no TSE.",
        sourceIds: [0, 1],
      },
      {
        id: "c2",
        status: "true",
        score: 92,
        text: "“A margem de erro é de dois pontos percentuais.”",
        note: "Valor confirmado no relatório do instituto.",
        sourceIds: [1],
      },
      {
        id: "c3",
        status: "context",
        score: 58,
        text: "“O resultado garante virada no segundo turno.”",
        note: "Pesquisa é retrato do momento; projeção exige cautela.",
        sourceIds: [0],
      },
    ],
    transcript: null,
    sources: [
      { outlet: "TSE — Registro de pesquisas", detail: "Base oficial · mock", url: "#" },
      { outlet: "Instituto MockPesquisa — Relatório completo", detail: "PDF oficial · mock", url: "#" },
    ],
  },
  {
    id: "mock-guia-eleitor",
    match: ["onde voto", "e-título", "etitulo", "local de votação", "guia do eleitor"],
    verdict: "true",
    score: 95,
    title: "[MOCK] “Onde voto no segundo turno?” — guia do eleitor",
    kind: "Link · Rede social (mock)",
    author: "@servico_mock",
    publishedAt: "11/10/2026",
    checkedAt: "há 8 h",
    summary:
      "Todas as orientações do post conferem com o passo a passo oficial: e-Título, local de votação e documentos aceitos.",
    claims: [
      {
        id: "c1",
        status: "true",
        score: 97,
        text: "“Dá para consultar o local de votação no e-Título.”",
        note: "Funcionalidade confirmada no aplicativo oficial.",
        sourceIds: [0],
      },
      {
        id: "c2",
        status: "true",
        score: 96,
        text: "“Documento com foto é aceito na seção.”",
        note: "Lista de documentos confirmada na página oficial.",
        sourceIds: [0, 1],
      },
      {
        id: "c3",
        status: "true",
        score: 94,
        text: "“Quem não votou no 1º turno pode votar no 2º.”",
        note: "Regra confirmada, desde que a situação esteja regular.",
        sourceIds: [1, 2],
      },
    ],
    transcript: null,
    sources: [
      { outlet: "TSE — Aplicativo e-Título", detail: "Página oficial · mock", url: "#" },
      { outlet: "TSE — Dúvidas do eleitor", detail: "Página oficial · mock", url: "#" },
      { outlet: "Agência Brasil — Guia do 2º turno", detail: "Reportagem · mock", url: "#" },
    ],
  },
  {
    id: "mock-grafico-precos",
    match: ["gráfico", "grafico", "preços", "precos", "série histórica", "inflação"],
    verdict: "misleading",
    score: 28,
    title: "[MOCK] Gráfico corta série histórica de preços",
    kind: "Imagem · Encaminhada (mock)",
    author: "Imagem encaminhada (mock)",
    publishedAt: "10/10/2026",
    checkedAt: "há 12 h",
    summary:
      "Os valores são reais, mas o recorte omite o período anterior e inverte a tendência. Enganoso por omissão de contexto.",
    claims: [
      {
        id: "c1",
        status: "true",
        score: 90,
        text: "“Os valores do gráfico existem na série oficial.”",
        note: "Números conferem com a base pública citada.",
        sourceIds: [0],
      },
      {
        id: "c2",
        status: "false",
        score: 15,
        text: "“A tendência mostrada representa o período completo.”",
        note: "O corte omite meses anteriores e inverte a leitura.",
        sourceIds: [0, 1],
      },
    ],
    transcript: null,
    sources: [
      { outlet: "IBGE — Série histórica de preços", detail: "Base oficial · mock", url: "#" },
      { outlet: "Aos Fatos — Checagem do gráfico", detail: "Agência de checagem · mock", url: "#" },
    ],
  },
  {
    id: "mock-print-frase",
    match: ["print", "frase", "atribui", "montagem"],
    verdict: "unproven",
    score: 47,
    title: "[MOCK] Print sem origem atribui frase a candidato",
    kind: "Imagem · Print (mock)",
    author: "Print encaminhado (mock)",
    publishedAt: "09/10/2026",
    checkedAt: "há 1 dia",
    summary:
      "Nenhum vídeo, transcrição ou registro confirma a frase. A imagem circula sem fonte há três dias.",
    claims: [
      {
        id: "c1",
        status: "unproven",
        score: 47,
        text: "“O candidato disse a frase atribuída no print.”",
        note: "Busca em vídeos, transcrições e registros não localizou a fala.",
        sourceIds: [],
      },
    ],
    transcript: null,
    sources: [
      { outlet: "Busca reversa da imagem", detail: "Sem origem localizada · mock", url: "#" },
    ],
  },
];

export const MOCK_FALLBACK = {
  id: "mock-generico",
  verdict: "unproven",
  score: 47,
  title: "[MOCK] Checagem de conteúdo enviado",
  kind: "Texto / link (mock)",
  author: "Conteúdo enviado pelo leitor",
  publishedAt: "12/10/2026",
  checkedAt: "agora",
  summary:
    "Encontramos poucas fontes sobre este conteúdo específico. Uma afirmação parece plausível, outra não tem comprovação disponível e uma terceira precisa de contexto antes de qualquer conclusão.",
  claims: [
    {
      id: "c1",
      status: "context",
      score: 55,
      text: "“A declaração circula com cortes diferentes em cada rede.”",
      note: "Versões divergem; o contexto original importa.",
      sourceIds: [1],
    },
    {
      id: "c2",
      status: "unproven",
      score: 40,
      text: "“Os números citados não aparecem em nenhuma base pública.”",
      note: "Busca em bases abertas não retornou correspondência.",
      sourceIds: [],
    },
    {
      id: "c3",
      status: "true",
      score: 88,
      text: "“O tema está na agenda do segundo turno.”",
      note: "Cobertura recente confirma a relevância do assunto.",
      sourceIds: [0, 1],
    },
  ],
  transcript: null,
  sources: [
    { outlet: "Busca em bases oficiais", detail: "Sem correspondência · mock", url: "#" },
    { outlet: "Cobertura recente do tema", detail: "Agregador · mock", url: "#" },
  ],
};

export const MOCK_FEED = [
  {
    id: "feed-1",
    verdict: "false",
    score: 12,
    category: "Urnas",
    title: "[MOCK] Áudio de WhatsApp sobre urnas eletrônicas",
    excerpt:
      "As 3 afirmações centrais do áudio repetem boatos já desmentidos por auditorias públicas. Nenhuma fonte sustenta o conteúdo.",
    author: "Encaminhado (mock)",
    checkedAt: "há 26 min",
    claimsCount: 3,
    sourcesCount: 3,
    resultId: "mock-urna-audio",
  },
  {
    id: "feed-2",
    verdict: "mixed",
    score: 62,
    category: "Candidatos",
    title: "[MOCK] Vídeo: deputado fala sobre segundo turno no Instagram",
    excerpt:
      "Das 4 afirmações, 2 se sustentam em fontes oficiais, 1 está sem comprovação e 1 contradiz os dados públicos.",
    author: "Deputado N. F. (mock)",
    checkedAt: "há 2 h",
    claimsCount: 4,
    sourcesCount: 4,
    resultId: "mock-nicolas-video",
  },
  {
    id: "feed-3",
    verdict: "mostly_true",
    score: 84,
    category: "Pesquisas",
    title: "[MOCK] Post sobre pesquisa de intenção de voto",
    excerpt:
      "Números batem com a pesquisa registrada no TSE dentro da margem. Só o comentário sobre “virada” extrapola os dados.",
    author: "@eleitor_mock",
    checkedAt: "há 5 h",
    claimsCount: 3,
    sourcesCount: 2,
    resultId: "mock-pesquisa-link",
  },
  {
    id: "feed-4",
    verdict: "true",
    score: 95,
    category: "Serviço",
    title: "[MOCK] “Onde voto no segundo turno?” — guia do eleitor",
    excerpt:
      "Todas as orientações do post conferem com o passo a passo oficial: e-Título, local de votação e documentos aceitos.",
    author: "@servico_mock",
    checkedAt: "há 8 h",
    claimsCount: 3,
    sourcesCount: 3,
    resultId: "mock-guia-eleitor",
  },
  {
    id: "feed-5",
    verdict: "misleading",
    score: 28,
    category: "Economia",
    title: "[MOCK] Gráfico corta série histórica de preços",
    excerpt:
      "Os valores são reais, mas o recorte omite o período anterior e inverte a tendência. Enganoso por omissão de contexto.",
    author: "Imagem encaminhada (mock)",
    checkedAt: "há 12 h",
    claimsCount: 2,
    sourcesCount: 2,
    resultId: "mock-grafico-precos",
  },
  {
    id: "feed-6",
    verdict: "unproven",
    score: 47,
    category: "Candidatos",
    title: "[MOCK] Print sem origem atribui frase a candidato",
    excerpt:
      "Nenhum vídeo, transcrição ou registro confirma a frase. A imagem circula sem fonte há três dias.",
    author: "Print encaminhado (mock)",
    checkedAt: "há 1 dia",
    claimsCount: 1,
    sourcesCount: 1,
    resultId: "mock-print-frase",
  },
];

export const MOCK_EXAMPLES = [
  { tab: "video", label: "Vídeo do Instagram", text: "https://www.instagram.com/reel/mock-nicolas-segundo-turno" },
  { tab: "text", label: "Áudio de WhatsApp", text: "Áudio de WhatsApp dizendo que a urna transmite voto pela internet" },
  { tab: "text", label: "Pesquisa de intenção de voto", text: "Post com pesquisa de intenção de voto para o segundo turno" },
];
