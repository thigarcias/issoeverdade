# isso é verdade?

Verificador automático de afirmações públicas no Brasil. Envie link, texto,
imagem ou vídeo/áudio e receba um resultado com afirmações, evidências vinculadas,
limites explícitos e, quando houver base, uma nota 0–100. A nota **não** é
probabilidade calibrada e o sistema pode não atribuir veredito.

## Rodar localmente

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # build de produção
npm run lint       # oxlint
npm test           # regressões (node --test: rede, limites, moderação, evidências, worker)
```

Crie um `.env` na raiz (já ignorado pelo git). O arquivo
[.env.example](.env.example) lista todas as variáveis com os valores padrão.

```bash
OPENAI_API_KEY=...            # avaliação factual/visão, transcrição e moderação
OPENCODE_API=...              # provedor alternativo (OpenCode Go)
ADMIN_SECRET=...              # habilita /admin
BLOB_READ_WRITE_TOKEN=...     # opcional: cache/logs/correções/config privados na Vercel Blob
MEDIA_WORKER_URL=...          # worker remoto para mídia; necessário em serverless
MEDIA_WORKER_SECRET=...
UPSTASH_REDIS_REST_URL=...    # opcional: limites compartilhados (obrigatório em produção)
UPSTASH_REDIS_REST_TOKEN=...
```

Sem `BLOB_READ_WRITE_TOKEN`, cache, logs e configuração ficam apenas em memória
da instância (o código registra isso na interface em vez de fingir persistência).
Sem armazenamento compartilhado de limites, **produção recusa novas checagens**
(`IEV_LIMITS_MODE=memory` é a única forma de declarar o modo degradado).

## Rotas

| Rota | Papel |
| --- | --- |
| `/` | site público: verificador, histórico local e transparência |
| `/admin` | **URL canônica do painel** — `vercel.json` reescreve para o SPA; em Vite dev o fallback de SPA já resolve |
| `/#/admin` | alias equivalente aceito pelo roteador do app |
| `POST /api/verify` | execução da checagem com progresso NDJSON incremental (`accepted`/`content`/`activity`/`result`/`error`); admissão recusada continua JSON+status (`api/verify.js` na Vercel, `vite.api-plugin.js` em dev) |
| `GET /api/health` | limites e modos vigentes, sem segredos (smoke de implantação) |
| `POST /api/corrections` | contestação pública: cria protocolo e entra na fila de revisão |
| `GET /api/corrections?protocol=` | estado público de um protocolo |
| `GET /api/corrections?checkId=` | estado público das contestações de uma checagem (usado pelo link do card) |
| `GET/POST /api/admin` | registros, catálogo+configuração de IA, fila de correções, métricas e invalidação de cache (Bearer `ADMIN_SECRET`) |
| `/metodologia.html`, `/correcoes.html`, `/privacidade.html` | transparência pública |

Painéis do `/admin`: registros, correções, modelos/provedores, metodologia e
métricas (volume, latência, abstenção, alertas e estado dos controles).

## Limites, custo e segurança

- **Política de URL** (`server/net.js`): apenas HTTP/HTTPS público, sem
  credenciais, portas permitidas (`IEV_HTTP_PORTS`), bloqueio de IPv4/IPv6
  internos (incluindo mapeados, NAT64, 6to4, Teredo), revalidação em cada
  redirect e conexão fixada no endereço validado (anti DNS rebinding).
- **Tetos de transferência**: bytes por resposta, por arquivo, por job e vigia de
  disco que mata a árvore de processos do `yt-dlp`/`ffmpeg` (`server/proc.js`).
- **Duração**: mídia acima de `IEV_MAX_MEDIA_SECONDS` não é processada.
- **Worker**: recusa iniciar sem `WORKER_SECRET`, valida URL internamente,
  limita concorrência e apaga temporários órfãos na inicialização.
- **Abuso/custo** (`server/limits.js`): limite de taxa por origem, vagas de
  concorrência com lease, orçamento diário em unidades e contagem de tokens —
  tudo em armazenamento compartilhado quando configurado; sem ele, produção
  recusa (fail-closed). Conciliação pós-checagem cobra unidades pelos tokens
  observados (`IEV_TOKENS_PER_UNIT`). Chave de interrupção operacional:
  `IEV_LIMITS_MODE=off` para novas checagens mantendo as páginas públicas no ar.
- **Moderação** (`server/moderation.js`): triagem de propósito, moderação de
  texto e de imagens/frames, recusa só de conteúdo que não pode ser processado
  (abuso sexual infantil, sexual explícito) e cobertura de vídeo declarada
  explicitamente (`MEDIA_VIDEO_MODERATION`).
  Os quadros selecionados são moderados individualmente (uma imagem por
  requisição), agregando categorias e o maior score observado. Falha mantém
  bloqueio em modo obrigatório; os motivos ficam no registro de erro do Admin.
- **Evidências** (`server/evidence.js`): obtém o documento de cada fonte
  vinculada (HTML/PDF), localiza o trecho citado, registra o que não foi
  localizado e revisa a fidelidade antes de fixar score/veredito. Ausência de
  trecho nunca é tratada como prova de falsidade.

Deep-link do detalhe: `/admin?detail=<id>` (restaurado no carregamento e no
`popstate`, sem reabrir um detalhe já fechado quando a resposta chega atrasada).

## Chaves e modelos

As chaves ficam somente no servidor. Modelos são escolhidos **por etapa**
(avaliação factual, visão/OCR, transcrição) em *Modelos & provedores*, a
partir do inventário descoberto nos provedores configurados:
- Elegibilidade vem de um registro explícito de protocolos/capacidades por
  provedor (`server/ai-config.js`), compartilhado pelo catálogo e pela
  resolução de endpoint — sem inferência por semelhança de nome. Modelos sem
  adapter/capacidade validados aparecem no inventário e na matriz por etapa
  com o motivo específico (`other_step`, `no_adapter`,
  `unvalidated_capability`, `missing_credential`, `not_in_inventory`,
  `stale_inventory`), mas não podem ser selecionados.
- Combinação incompatível é rejeitada no servidor (HTTP 400 com campo
  específico) e **não** altera a configuração vigente.
- Não há troca automática de provedor quando uma etapa falha: a falha é
  registrada como erro operacional e o par escolhido é o que executa.
- A configuração é versionada (revisão) e a revisão integra o namespace do
  cache, então uma nova revisão não reaproveita resultado antigo.
- Os padrões de avaliação factual e visão são OpenCode Go / GPT-6 Luna
  (`gpt-6-luna`); o padrão de transcrição permanece OpenAI / `whisper-1`.
  Preferências persistidas válidas prevalecem sobre os padrões.
- Não existe seletor de segunda avaliação `final`. Uma chave extra em
  configurações antigas é ignorada; o painel conserva a leitura dessa etapa
  somente no detalhe de execuções históricas.

Variáveis opcionais: `IEV_JUDGE`, `IEV_VISION` e `IEV_TRANSCRIBE` (JSON
`{"provider":"...","model":"..."}` por etapa), além de `OPENAI_TRANSCRIBE_MODEL`.

## Dados e privacidade

Uploads de imagem e vídeo/áudio enviam bytes reais (limite de 3 MiB, validação
por assinatura). Sem worker, desenvolvimento usa `ffprobe`/`ffmpeg` locais;
serverless sem worker declara indisponibilidade. Worker configurado não tem
fallback silencioso se falhar. O navegador guarda até 20 resultados em
`localStorage`; logs/cache no servidor dependem do Blob privado ([privacidade](docs/privacidade-dados-ia.md)).

O POST de checagem transmite NDJSON: `accepted` entrega o mesmo `checkId`
usado no registro/resultado e uma capacidade secreta `recoveryToken`.
O cliente aceita o evento terminal mesmo sem quebra de linha no EOF e preserva
UTF-8 dividido entre chunks. Se a conexão acabar sem terminal, tenta uma única
consulta `GET /api/verify?checkId=...`, com o segredo apenas no cabeçalho
`X-Verify-Recovery`, nunca na URL, no histórico ou no armazenamento do navegador.
Não há polling nem repetição automática da inferência. `pending` (202) ou falha
transitória permite nova consulta explícita; falha definitiva/expiração descarta
a capacidade, e só uma próxima ação explícita pode iniciar outro POST.
Ela permanece apenas em memória para a mesma entrada/contexto e identidade de
arquivo. A recuperação expira logicamente 30 minutos após aceitação; pendência
sem conclusão após 5 minutos retorna falha. O envelope fica em Blob privado ou
memória limitada a 200 registros, sem garantia de exclusão física pelo TTL.
GET não executa IA, admissão de POST, reserva de orçamento ou conciliação de
tokens. Um POST que acerta cache ainda passa pela admissão existente, mas não
recontabiliza o consumo antigo de IA. Se a cópia recuperável falhar ao persistir,
o resultado válido ainda é entregue com `recoveryAvailable: false`.

Na entrada rápida, digite ou cole **texto ou link**: o teclado é de texto e a
interface identifica links HTTP/HTTPS automaticamente. No verificador completo,
a aba **Imagem** aceita um **contexto opcional**, separado dos campos de texto e
URL das outras abas. Você pode enviar somente a imagem ou explicar a alegação,
origem e data alegadas (até o limite de texto do servidor, 8.000 caracteres por
padrão). O contexto segue em `input.context` para a análise, é tratado como dado
não confiável e não comprova autenticidade. Trocar de aba ou limpar descarta o
conteúdo anterior, evitando reutilizar texto/contexto em outra entrada.

O card do resultado abre o diálogo de compartilhamento com prévias PNG geradas
localmente, sempre verticais de **1080 × 1920 px** (9:16). A imagem é um parecer rápido:
veredito global e nota (ou sua indisponibilidade), cobertura compacta, texto
integral de cada afirmação com score/status e pontos não checados identificados
separadamente. Não repete resumos longos, justificativas nem trechos de evidência:
esses detalhes, motivos, limites e fontes com URLs continuam completos no
resultado e no texto copiado ou compartilhado. Não há teto de três pontos nem
corte de texto; quando o conteúdo não cabe com fonte legível, são geradas páginas
numeradas. Um ponto maior que uma página segue com rótulo de
**continuação**, sem omitir seu texto. O rodapé informa quantidade de fontes,
limitação essencial, checagem automática e identificação da checagem/site.
O card segue a identidade do site (creme, tinta e vermelho): marca e veredito em Faustina (serifa); pontos, status e rótulos em Geist. Sem caixas nem faixas: o veredito e a nota dominam o topo; cada ponto é separado por uma régua fina, com número, texto e, sob ele, o status com a nota à direita. Pontos não checados ficam em seção própria. Nas páginas seguintes, uma linha de contexto repete o veredito e a nota. No PNG de 1080 px: marca 36 px, veredito 76 px, nota 136 px, pontos 30 px, status e rótulos 24 px, rodapé 24 px.
Texto e rótulos continuam explicitando o resultado, sem depender somente da cor.
O diálogo permite navegar pelas páginas e baixar a imagem selecionada.
Onde o aparelho aceita todos os arquivos via Web Share, **Compartilhar imagens e
texto** abre o seletor do sistema com todos os PNGs (escolha WhatsApp nele); não
há envio automático nem garantia de que o WhatsApp será escolhido.
Sem suporte ao conjunto de arquivos, o diálogo oferece download das páginas,
**Copiar texto** e **Abrir WhatsApp com texto**, avisando que todas as imagens
devem ser anexadas manualmente. Resultados sem veredito mantêm essa limitação,
sem inventar nota/selo factual. Resultados “sem comprovação” preservam os pontos
e o status de limitação, mas a nota indisponível nunca é convertida em zero.

Links sociais usam texto disponível em oEmbed, worker, yt-dlp ou OpenGraph e
seguem até três links documentais presentes nesse texto, dentro de limites. Texto
do post e anexos são cobertos separadamente; metadados não são transcrição.
Em hosts de post ambíguo (X/Twitter), a presença de áudio/vídeo é confirmada
antes de anunciar a aquisição: post sem anexo audiovisual não exibe "Baixando a
mídia" e segue apenas com o texto disponível; falha do probe não bloqueia o
fluxo normal de download. `IEV_MEDIA_PRESENCE_TIMEOUT_MS` limita o probe tanto
localmente quanto no worker. O servidor envia um orçamento menor que o timeout
HTTP para o worker encerrar o subprocesso e liberar a vaga antes da continuação;
desconexões também cancelam o probe. Implante o worker junto com o servidor para
ativar esse contrato de timeout. Áudio sem vídeo não exige frames; vídeo só é analisado
após validar duração e trilhas, com transcrição/OCR parciais. Sem conteúdo lido,
não há score/veredito.
Links diretos são encaminhados por modalidade: PDF textual ao `unpdf`, JPEG/PNG/WebP
à moderação e visão, áudio/vídeo ao processador audiovisual. A revisão de extração
`article-content-v4` invalida cache anterior; as regras de perguntas e ações futuras introduzidas em `fact-check-5` permanecem em `fact-check-11`.
O cronômetro da interface mede a duração da checagem iniciada, não o tempo desde a época Unix.

Links comuns de notícias passam por extração HTML pública com limites de rede,
antes do julgamento com busca web. A cobertura distingue corpo estruturado
completo recebido (`full`), metadados/trechos (`partial`) e falha de acesso
(`inaccessible`). Isso não autentica a matéria nem garante que o site forneceu
todo o artigo. Se o acesso falhar, a pesquisa usa URL, título, publicação e
alegações identificáveis, sem fingir leitura integral. `needs_media` legado não
encerra esse caminho: há pesquisa antes da abstenção. Só a impossibilidade de
identificar alegações justifica `insufficient_input`; ausência de provas para
uma alegação identificada mantém `unproven`, sem forçar verdadeiro/falso.

O classificador compartilhado distingue HTML, post social, PDF, imagem, áudio e
vídeo; MIME e assinatura refinam o tipo quando há amostra disponível. Links de
Spotify são candidatos a áudio apenas para episódios. Login-wall, paywall,
captcha, streams protegidos e conteúdo removido continuam limitações externas.

## Metodologia e avaliação

As novas checagens usam `fact-check-11`: investigam alegações implícitas em
perguntas e justaposições, distinguindo comparação factual, motivação atribuída
e juízo de valor. Recortes de manchetes também exigem pesquisa da publicação
original, fidelidade e datas, sem autenticação por OCR/logotipo. O fluxo executa
uma avaliação factual com busca (`judge`), pesquisa direcionada condicional para
notícias (`article-research`), documentos (`evidence`) e revisão JEV do conjunto
(`evidence-review`), seguida de validação determinística. Não há segunda
avaliação factual/de mídia obrigatória nem geração/revisão editorial por IA.
HTML de reprodução de vídeo sem transcrição fica indisponível como prova de
fala; a pesquisa prioriza reportagens textuais, documentos e transcrições.
O coletor reutiliza corpos estruturados de artigos e cache por URL, respeitando
os tetos de documentos e bytes. A revisão avalia **o conjunto de evidências
de cada claim**; comparações qualitativas não exigem cálculo anual. Sem suporte
adequado, o claim fica `unproven`; fontes somente escritas pelo modelo continuam
descartadas. `/admin` exibe proveniência, dossiê, moderação e subetapas de mídia.
Registros e smokes anteriores preservam sua versão histórica.
A síntese é construída deterministicamente a partir das classificações e
alegações validadas, com limites de cobertura; não executa nova chamada ao modelo.

Notas por afirmação com evidência adequada: `true=95`, `context=70`, `false=5`.
`unproven` recebe `score=null`, não zero. Havendo qualquer afirmação sem
comprovação ou omitida, a nota global também é `null` e o veredito `unproven`;
a média só inclui resultados totalmente avaliados. `evidenceSupport`
(`supports`, `refutes`, `context`, `insufficient`) descreve suporte factual;
`coverage` (`total`, `assessed`, `unproven`, `omitted`) descreve alcance da
avaliação. A interface, o detalhe e o compartilhamento preservam essa distinção.

A revisão de evidências padrão usa JEV `jev-1.13-free` via OpenCode/SystemOne
(`IEV_EVIDENCE_REVIEW_PROVIDER=jev|judge`), sem fallback automático.
Uma resposta JEV só determina a relação do grupo com probabilidade máxima de
classe ≥0,8 e margem ≥0,2; ambiguidade mantém abstenção. A resposta é
`{claims:[{claimIndex,verdict,note}]}`; `claim.evidenceReview` registra
`verdict`, `verification`, `incomplete` e `evidenceIndices`. Na revisão agrupada,
cada trecho fica `relation: "context"`: sua `verification` é documental, não
prova semântica independente. Esses limiares não são probabilidades calibradas.

Comparações anuais usam `comparison` com `metric`, `region`, `unit`, `dataset`,
`operator` e dois `groups` (`label`, `startYear`, `endYear`, `rows`). Cada linha
contém `year`, `valueText`, `numberFormat: "pt-BR"|"en-US"`, `scale: 1|1000|1000000`,
`evidenceId` e `complete`. Ano, valor literal, unidade e escala precisam estar
no trecho localizado; não se usam operandos sem localização. Separadores
ambíguos exigem o formato da fonte, não o idioma da resposta. Nomes de metadados
não precisam aparecer literalmente: homogeneidade declarada é estrutural e
a semântica é conferida no grupo. O servidor soma decimais exatamente e registra
`status: complete|lower_bound|partial|invalid`, `eligible`, `relation`, `scope`,
`reason`, totais, linhas e cobertura. Recortes menores não viram mandatos inteiros;
dados parciais não autorizam extrapolação. Um limite inferior só estabelece a
desigualdade quando um subtotal de área não negativa já supera o total completo
do outro lado, nunca igualdade ou previsão. A conclusão ainda exige revisão
documental compatível do conjunto. Detalhes em [Metodologia](docs/metodologia-factual.md).

Na validação, o objeto de cada afirmação não é substituído por outra pergunta.
Texto, período e limites continuam vinculados às evidências daquela afirmação. O suporte
dos trechos é separado da classificação; contexto verificável não promove
automaticamente uma alegação sem comprovação. A versão da metodologia e a
configuração da revisão de evidências também separam as entradas do cache.

Desfechos possíveis: `checked`, `partial_coverage`, `insufficient_input`,
`inaccessible_media`, `no_verifiable_claims`, `content_refused` (política de
conteúdo) e `moderation_uncovered` (vídeo sem cobertura declarada).

Regressões: `npm test`. Avaliação de corpus:
`node scripts/evaluate-factual.mjs <corpus.jsonl>` (tabelas por
modalidade/categoria, aviso de amostra insuficiente, `--check-split` contra
vazamento e `--require chave>=valor` para gates) e
`node scripts/corpus-tool.mjs` (`init`, `validate`, `agreement`, `adjudicate`,
`split`). Guia em [docs/avaliacao-corpus.md](docs/avaliacao-corpus.md).

- [docs/metodologia-factual.md](docs/metodologia-factual.md): fluxo efetivo,
  estados operacionais, faixas de score e limites de evidência.
- [docs/politica-correcoes.md](docs/politica-correcoes.md): canal público,
  estados da fila e o que o sistema corrige automaticamente.
- [docs/plano-lancamento-producao.md](docs/plano-lancamento-producao.md): gates
  para beta/divulgação e o que ainda falta antes de divulgar.
- [docs/guardrails-seguranca-plano.md](docs/guardrails-seguranca-plano.md):
  guardrails e estado de implementação.
- Harness de avaliação: **não há corpus humano entregue nem taxa de precisão
  publicada.**

## Design

Creme `#F2ECDC`, tinta `#1A140C`, vermelho `#D9341F`, serifada Faustina + Geist,
bordas duras e sombra offset. O shell administrativo reusa a identidade com
tipografia sans para dados/controles e navegação lateral no desktop.

No mobile, cabeçalhos, selos, controles e navegação administrativa quebram
linha sem esconder conteúdo horizontalmente. URLs e autoria sem separadores
podem quebrar dentro do resultado; nomes de uploads preservam o botão de
remoção. Os diálogos usam a largura disponível, e tabelas de comparação e a
matriz de modelos empilham os campos com rótulos visíveis, mantendo os cabeçalhos
para leitores de tela. Resumos ausentes não geram um parágrafo vazio.

Prova visual em Chromium/Vite realizada em **320, 375 e 390 px**: formulário
com nome de arquivo longo, progresso, resultado com fontes/URLs/autoria longas,
comparações, detalhe do histórico, compartilhamento com e sem Web Share e
checagens/modelos/detalhes do Admin ficaram com `scrollWidth` igual à largura
do viewport, sem controles horizontalmente cortados. Também foram exercitadas
fontes maiores (rótulos de 20 px e texto de 22–26 px) e resumo vazio.
Os dados representativos foram injetados somente no navegador para inspecionar
os componentes reais; isso não comprova execução de IA, upload ao servidor ou
envio pelo seletor nativo. Nenhum build, lint, teste ou formatador foi executado
nessa verificação mobile.
