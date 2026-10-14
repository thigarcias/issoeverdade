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
OPENAI_API_KEY=...            # julgamento/final/visão, transcrição e moderação
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
| `POST /api/verify` | execução da checagem (`api/verify.js` na Vercel, `vite.api-plugin.js` em dev) |
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
- **Evidências** (`server/evidence.js`): obtém o documento de cada fonte
  vinculada (HTML/PDF), localiza o trecho citado, registra o que não foi
  localizado e revisa a fidelidade antes de fixar score/veredito. Ausência de
  trecho nunca é tratada como prova de falsidade.

Deep-link do detalhe: `/admin?detail=<id>` (restaurado no carregamento e no
`popstate`, sem reabrir um detalhe já fechado quando a resposta chega atrasada).

## Chaves e modelos

As chaves ficam somente no servidor. Modelos são escolhidos **por etapa**
(julgamento, conclusão, visão/OCR, transcrição) em *Modelos & provedores*, a
partir do inventário descoberto nos provedores configurados:

- Modelos sem protocolo/capacidade validados aparecem no inventário com o
  motivo, mas não podem ser selecionados.
- Combinação incompatível é rejeitada no servidor (HTTP 400 com campo
  específico) e **não** altera a configuração vigente.
- Não há troca automática de provedor quando uma etapa falha: a falha é
  registrada como erro operacional e o par escolhido é o que executa.
- A configuração é versionada (revisão) e a revisão integra o namespace do
  cache, então uma nova revisão não reaproveita resultado antigo.

Variáveis opcionais de compatibilidade: `IEV_<ETAPA>` (JSON por etapa) e
`OPENAI_TRANSCRIBE_MODEL`.

## Dados e privacidade

Uploads de imagem e vídeo/áudio enviam bytes reais (limite de 3 MiB, validação
por assinatura). Sem worker, desenvolvimento usa `ffprobe`/`ffmpeg` locais;
serverless sem worker declara indisponibilidade. Worker configurado não tem
fallback silencioso se falhar. O navegador guarda até 20 resultados em
`localStorage`; logs/cache no servidor dependem do Blob privado ([privacidade](docs/privacidade-dados-ia.md)).

Na entrada rápida, digite ou cole **texto ou link**: o teclado é de texto e a
interface identifica links HTTP/HTTPS automaticamente. No verificador completo,
a aba **Imagem** aceita um **contexto opcional**, separado dos campos de texto e
URL das outras abas. Você pode enviar somente a imagem ou explicar a alegação,
origem e data alegadas (até o limite de texto do servidor, 8.000 caracteres por
padrão). O contexto segue em `input.context` para a análise, é tratado como dado
não confiável e não comprova autenticidade. Trocar de aba ou limpar descarta o
conteúdo anterior, evitando reutilizar texto/contexto em outra entrada.

O card do resultado oferece **Compartilhar no WhatsApp**: abre o WhatsApp com
título, nota/veredito quando disponíveis, resumo, URL original quando presente e
link do site. Resultados sem veredito mantêm essa limitação na mensagem. O envio
e a escolha do destinatário ficam a cargo do usuário; o botão não envia o PNG.

Links sociais usam texto disponível em oEmbed, worker, yt-dlp ou OpenGraph e
seguem até três links documentais presentes nesse texto, dentro de limites. Texto
do post e anexos são cobertos separadamente; metadados não são transcrição.
Áudio sem vídeo não exige frames; vídeo só é analisado após validar duração e
trilhas, com transcrição/OCR parciais. Sem conteúdo lido, não há score/veredito.
Links diretos são encaminhados por modalidade: PDF textual ao `unpdf`, JPEG/PNG/WebP
à moderação e visão, áudio/vídeo ao processador audiovisual. A revisão de extração
`article-content-v4` invalida cache anterior sem alterar `fact-check-5`.
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

`fact-check-5` investiga alegações implícitas em perguntas e distingue ações futuras de declarações ou medidas verificáveis. Mantém a captura de anotações e fontes estruturadas da busca, compartilha o
dossiê entre julgamento/revisão, distingue períodos de pesquisa e paraleliza
transcrição/visão. Depois da revisão final, o servidor obtém os documentos das
fontes vinculadas, localiza os trechos citados e revisa a fidelidade das
citações: quando nenhuma citação sobrevive à revisão, o claim volta para
`unproven` com justificativa própria. `/admin` exibe proveniência, dossiê,
moderação e subetapas de mídia. Fontes somente escritas pelo modelo continuam
sendo descartadas.

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
