# Bateria de fontes e links — relatório de falhas

Data: 2026-10-13. Método: `scripts/source-battery.mjs` (62 URLs + 8 uploads) + sondas
dirigidas em `server/*` com servidores locais controlados e rede real. IA chamada
só no teste de endpoint não-HTTP (11 checagens); o resto é leitura/parse/validação.

Reprodução rápida: `node scripts/source-battery.mjs --out tmp-dl/source-battery-full.json`
e `npm test` (71/71 passando antes e depois — nenhum teste quebrou).

Legenda: 🔴 quebra funcional · 🟡 degradação/lacuna · 🔵 endurecimento.

---

## 🔴 F1 — `--max-downloads 1` faz yt-dlp sair 101 e o app descarta áudio/vídeo válido

- Onde: `server/media.js:288` (downloadViaYtDlp), `:354` (framesViaYtDlp),
  `worker/server.js:110` (ytdlpArgs — probe, áudio e frames).
- Evidência: `yt-dlp ... --max-downloads 1 -o ... <youtube>` baixa e converte o
  MP3, imprime o caminho em stdout e sai com **code 101**
  (`[info] Maximum number of downloads reached... Aborting remaining downloads`).
  `runLimited` trata `code !== 0` como falha, `downloadViaYtDlp` retorna
  `download-failed`, cai para `downloadViaDirectUrl` (sem `og:video` no YouTube)
  e o resultado final é `no-direct-video-url`. Sem `--max-downloads`, o mesmo
  comando sai 0. Bissecção executada em `tmp-dl/test-media` (com/sem flag,
  com/sem watcher, `spawn` cru): só a flag muda o exit.
- Impacto: **todo download de áudio e frame via yt-dlp local falha após baixar
  com sucesso** — YouTube, TikTok e qualquer outro. O worker tem o mesmo bug
  no probe (`--dump-json` com a flag sai 101 com 662 KB de JSON válido em
  stdout, mas `run.ok=false` → `probe-failed`), então produção via worker
  também perde probe+áudio+frames.
- Por que os testes não pegam: `server/media.test.js` só exercita
  `downloadViaDirectUrl` (servidor local), nunca `downloadViaYtDlp`.
- Correção sugerida: remover `--max-downloads 1` (já há `--no-playlist`) ou
  aceitar `code === 101` com stdout/arquivo válido como sucesso.

## 🔴 F2 — `downloadAudio`/`downloadFrames` retornam motivo genérico e somem com o detalhe

- Onde: `server/media.js:265-276,313-327`.
- Evidência: TikTok (`yt-dlp` funciona, code 0) falha por F1 e o motivo final é
  `no-direct-video-url`; X sem vídeo (`No video formats found!`) também vira
  `no-direct-video-url`. O `detail` do stderr (200 chars, já coletado) é
  descartado na queda para o próximo estágio. `mediaDebug` no log mostra só o
  último motivo — diagnóstico impossível sem reproduzir.
- Correção sugerida: acumular `detail`/motivos de cada estágio em `mediaDebug`
  (ex.: `ytdlp:download-failed:<stderr>` antes de tentar direct).

## 🔴 F3 — Links não-HTTP(S) na aba link gastam checagem de IA em vez de 400

- Onde: `server/endpoint.js:69` — a política de URL só roda se
  `/^https?:\/\//i.test(maybeUrl)`.
- Evidência: `kind:link` com `ftp://...`, `www.example.com/...`, `example.com`,
  `://x`, `javascript:alert(1)`, `data:text/plain,oi`, `"  "` retornam **200**
  com `insufficient_input`/`no_verifiable_claims` após 2–7 s de pipeline (com
  chamada de IA). Só `https://`-inválida recebe 400 `invalid_url`.
- Impacto: custo/latência por entrada que nunca pode virar checagem; `javascript:`
  e `data:` passam como "link" (sem XSS — nunca renderizado como HTML — mas
  semântica errada e gasto).
- Correção sugerida: na aba link, exigir `parseUrlStrict` ok para qualquer texto
  não-vazio (400 `invalid_url` caso contrário), não só para `^https?://`.

## 🟡 F4 — `fetchLinkedContext` (links dentro do post) só existe no caminho X

- Onde: `server/media.js:719-744` — `isX` chama `fetchLinkedContext`, `isInsta`
  e o caminho genérico não.
- Evidência: estático + bateria (`soc-instagram`, `soc-facebook`, `soc-threads`
  retornam só `opengraph:ok` com 25–270 chars; nenhum `linked:` nas tentativas).
  `docs/midia-links-sociais.md:98` já documenta a limitação como intenção, mas o
  efeito prático é que Instagram/Facebook/Threads com link externo perdem o
  contexto vinculado que o X recebe.
- Correção sugerida: aplicar `fetchLinkedContext` ao texto/descrição de qualquer
  `probeOEmbed`/yt-dlp bem-sucedido, não só X.

## 🟡 F5 — `likelyVideoUrl` (verify) e `isArticleUrl`/`SOCIAL_VIDEO_HOST` (media) divergem

- Onde: `server/verify.js:389-398` vs `server/media.js:507-518`.
- Evidência: Facebook, fb.watch, Threads, Reddit, Kwai, Spotify, Pinterest,
  LinkedIn são "não-artigo" no media (vão ao downloader de vídeo) mas "não-vídeo"
  no verify (vão ao `media-probe` leve, sem áudio/frames/transcrição). Spotify
  (`open.spotify.com/episode/...`) é classificado como **artigo** e retorna
  `http-400`. Resultado: vídeo de Facebook/Threads/Reddit/Kwai nunca tem
  transcrição nem OCR — só metadados — sem aviso específico de cobertura.
- Correção sugerida: unificar a taxonomia (uma função `classifyUrl`: artigo |
  vídeo | post-social | arquivo) usada por verify e media, com Spotify como áudio.

## 🟡 F6 — Arquivos diretos (PDF/imagem/MP4) têm tratamento inconsistente por extensão

- Onde: `server/media.js:508` (`MEDIA_PATH`), `fetchMediaContext`, `fetchDocument`.
- Evidência: `.pdf` vai ao yt-dlp (`yt-dlp:ok` para dummy.pdf!) e o dossiê diz
  `pdf-text-unavailable`; `.png` (`httpbin.org/image/png`) vai ao extrator de
  **artigo** e falha `non-html`/`unsupported-type:image/png`; `.mp4` vai ao
  yt-dlp (`yt-dlp:ok`) e o dossiê diz `unsupported-type:video/mp4`. Ou seja:
  PDF "lê" via downloader de vídeo mas sem texto; imagem tenta parse de artigo;
  MP4 direto funciona no yt-dlp mas o dossiê não o suporta. Nenhum caminho diz
  ao usuário "envie o arquivo na aba correspondente".
- Correção sugerida: rotear `MEDIA_PATH` para resposta própria ("arquivo direto:
  baixe e envie na aba vídeo/imagem") em vez de yt-dlp/artigo.

## 🟡 F7 — `Content-Length` declarado acima do teto rejeita mesmo com `truncate:true`

- Onde: `server/net.js:274-280` — checagem declarada antes do streaming, sem
  considerar `truncate`.
- Evidência: servidor local com 5000 bytes e `maxBytes:1024, truncate:true`
  lança `too_large` em vez de truncar; só chunked (sem Content-Length) trunca.
  Afeta `fetchArticleContext`/`fetchDocument` diante de páginas grandes com
  Content-Length: viram `inaccessible` em vez de `partial`.
- Correção sugerida: com `truncate:true`, ignorar o declarado e truncar no
  streaming (a proteção real continua sendo o teto por chunk + budget).

## 🟡 F8 — Entidades HTML latinas (`&ccedil;` etc.) não são decodificadas

- Onde: `server/text.js:6-19` — `ENTITIES` tem 14 entradas; sem fallback para
  entidades nomeadas fora da tabela.
- Evidência: `textFromHtml('&ccedil;')` devolve literal `&ccedil;`. Páginas BR
  com entities (`&atilde;`, `&ccedil;`, `&otilde;`, `&eacute;`...) vazam markup
  para títulos, contexto do modelo e trechos de evidência — e quebram
  `locateQuote` quando a citação usa o caractere real.
- Correção sugerida: tabela estendida (ao menos latin-1 `&[a-z]+;` comum em PT)
  ou decodificador de entidades completo.

## 🟡 F9 — `enforceDuration` trata qualquer falha do ffprobe como "duração ok"

- Onde: `server/media.js:140-153` (e `worker/server.js:155-165`).
- Evidência: arquivo inexistente, arquivo de 100 bytes de lixo e `maxSeconds=0`
  retornam `{ok:true, durationSec:null, detail:'ffprobe-unavailable'}`.
  Arquivo corrompido/baixado pela metade passa como válido para transcrição e
  frames (falha depois, com motivo confuso). O teto de duração não é aplicado
  quando o ffprobe falha.
- Correção sugerida: distinguir "ffprobe ausente" (ok, dev) de "ffprobe falhou
  no arquivo" (falhar com `duration-unreadable`).

## 🟡 F10 — `processUploadedMedia` exige worker; sem worker, upload de vídeo sempre falha

- Onde: `server/media.js:156-208` — `if (!WORKER_URL ...) return {no-worker-url}`.
- Evidência: com `yt-dlp`+`ffmpeg` locais instalados, `processUploadedMedia(buf)`
  retorna `no-worker-url`; `enrichUploadedMedia` gera contexto vazio e o vídeo
  cai em `inaccessible_media`. Local dev (sem Fly) não consegue checar upload de
  vídeo/áudio — só URL. README diz "Local com yt-dlp: camadas 1-2 diretas",
  mas isso vale só para URL, não upload.
- Correção sugerida: caminho local com ffmpeg (extrair MP3 + frames do buffer)
  quando `WORKER_URL` ausente, ou documentar a exigência.

## 🟡 F11 — `og:video` direto aceita qualquer extensão e escreve com ela

- Onde: `server/media.js:440-447`.
- Evidência: `ext` vem de `direct.split('?')[0].split('.').pop()` sem allowlist
  (`file.<ext>` com até 4 chars alfanuméricos). Um `og:video` apontando para
  `.../x.svg` ou `.../x.html` é salvo como `.svg`/`.html` e passado ao ffprobe.
  Baixo risco (só ffprobe lê, depois `rm`), mas `enforceDuration` falha-aberto
  (F9) e o "áudio" segue para transcrição.
- Correção sugerida: allowlist de extensões de mídia + checagem de Content-Type.

## 🟡 F12 — Quedas paralelas no mesmo `outDir/%(id)s` colidem (um downloader mata o outro)

- Onde: `server/media.js:291` (`-o ${outDir}/%(id)s.%(ext)s`, outDir fixo
  `./media-tmp`).
- Evidência: dois `yt-dlp -x` simultâneos do mesmo vídeo: A sai 0, B sai 1
  (conflito no `.part`/lock). Com `IEV_MAX_CONCURRENT_CHECKS=3`, duas checagens
  do mesmo link disputam o mesmo arquivo — uma falha ou, pior, lê MP3 parcial
  do outro job.
- Correção sugerida: diretório temporário por job (`mkdtemp`, como frames e
  worker já fazem).

## 🔵 F13 — `collectEvidence`/`prioritizeSources`/`reviewableCitations`/`applyReview` lançam com `null`

- Onde: `server/evidence.js:100-113,132-143,217-233,239-279` — defaults `= []`
  só cobrem `undefined`, não `null`.
- Evidência: `prioritizeSources(null,null)`, `collectEvidence({sources:null,
  claims:null})`, `reviewableCitations(null)`, `applyReview({claims:null,...})`
  lançam `TypeError`. Hoje `verify.js:945-947` normaliza com `Array.isArray`
  antes de chamar, então é latente — mas qualquer novo chamador (ou regressão
  na normalização) vira 502.
- Correção sugerida: `?? []` na entrada dessas funções.

## 🔵 F14 — `clip(value, 0)` retorna `slice(0,-1)+'…'` em vez de vazio

- Onde: `server/text.js:214-217`.
- Evidência: `clip('abcdef',0)` → `'abcde…'`; `clip('ab',0)` → `'a…'`. Hoje
  todos os chamadores usam max fixo > 0 ou `intEnv` (> 0), então é latente.
- Correção sugerida: `if (max <= 0) return ''`.

## 🔵 F15 — `locateQuote` com citação de 500 tokens leva ~2 s (regex `looseMatcher`)

- Onde: `server/text.js:121-129,183-196`.
- Evidência: doc 800 KB + quote 500 tokens repetidos → `approximate`, 1927 ms;
  quote 2000 tokens → 50 ms (cai em `tokens` porque… na verdade o matcher
  executa e falha rápido). Quotes vêm do modelo (limitadas a 600 chars em
  `sanitizeSources`, mas 600 chars ≈ 100 tokens ainda geram regex grande) e o
  dossiê roda isso por evidência (até 12 itens de revisão). Pior caso real:
  alguns segundos de CPU por checagem, sem timeout.
- Correção sugerida: teto de tokens no `looseMatcher` (ex.: 30) com fallback
  para `prefix`/`tokens`.

## 🔵 F16 — `moderateInput` é código morto; `purposeTriage` tem isenções largas

- Onde: `server/moderation.js:165-206`; nenhum import de `moderateInput` fora do
  próprio módulo (verify chama `moderateText`/`moderateImages`/`purposeTriage`
  diretamente).
- Evidência: `grep moderateInput` só encontra definição + teste inexistente.
  `purposeTriage` isenta texto > 600 chars, com qualquer URL ou **qualquer
  dígito** (`/\d/`): "resolva 2+2", "calcule 2+2", "me diga se isso é verdade:
  [com número]" passam para o pipeline pago. A isenção de dígito existe para não
  bloquear afirmações ("caiu 2%"), mas também isenta pedidos ("resuma em 3
  tópicos", "traduza 5 frases").
- Correção sugerida: remover `moderateInput` ou usá-lo; refinar triagem (ex.:
  dígito isenta só se houver padrão de afirmação, não de pedido).

## 🔵 F17 — Slot de concorrência: `Retry-After: 150` após esperar só 0,5–20 s

- Onde: `server/limits.js:255-275` — `acquireSlot` espera `slotWaitMs` (padrão
  20 s) e, ao desistir, sugere `slotLeaseSec/2` = 150 s.
- Evidência: com 1 vaga ocupada e `SLOT_WAIT_MS=500`, o 429 vem com
  `Retry-After: 150`. Cliente que obedece espera 2,5 min por uma vaga de lease
  5 min — conservador demais para contenção transitória.
- Correção sugerida: `Retry-After` proporcional à espera/polling (ex.: 5–10 s)
  ou `min(lease/2, 30)`.

## 🔵 F18 — Cobertura real por plataforma (o que a bateria mostra que funciona)

Sem falha, mas útil como mapa de capacidade (rede real, 2026-10-13):

| Grupo | Resultado |
|---|---|
| Notícias BR (g1, uol, folha, estadão, oglobo, bbc-br, agência-brasil, poder360) | `partial` via `html-paragraphs` em todas; nenhuma deu `full` (JSON-LD `articleBody` ausente nas homepages) nem `inaccessible` |
| Reuters/AP/IBGE/Medium | `http-401/403` (bot-wall) → `inaccessible`, preserva URL para pesquisa — comportamento correto |
| Wikipedia/gov.br/senado | `partial`, corpo até 18 mil chars (teto `ARTICLE_TEXT_MAX`) |
| X com link externo | `oembed:ok + linked:ok:t.co` (1420 chars de contexto) — o único social com contexto vinculado |
| YouTube/TikTok probe | `yt-dlp:ok` (metadados); download quebrado por F1 |
| Instagram/FB/Threads/Reddit/LinkedIn/Kwai/Vimeo/Twitch | `opengraph:ok` com 24–665 chars (só título/descrição genérica); login-wall impede mais — esperado sem credencial |
| t.co/bitly | segue redirect e extrai a matéria final (`linked:ok`, `article:partial`) |
| httpbin 404/500/403, redirect-loop, big-file | motivos estáveis (`http-NNN`, `too-many-redirects`, `non-html`), sem exceção |
| SSRF (localhost, loopback, metadata, 10/8, porta, creds, ftp, rótulo único, IPv6 loop, decimal/octal/hex IPv4, mapped) | todos `blocked:<código>` na policy, no fetch e no dossiê |
| Uploads (png ok, mime trocado, base64 ruim, kind errado, texto > 8000, kind inválido, gif/svg, data-URL, fileName gigante, 8000 exato) | aceitar/recusar exatos, status 400/413/415 corretos |
| Scoring validator (20 mutações: NaN, string, 999, veredito divergente, outcome lixo, evidence fora do índice, null) | sempre converge para `no_verifiable_claims` ou corrige com `corrections[]`, nunca lança |
| Correções (POST→GET protocolo→GET checkId, honeypot, curta, protocolo ruim) | fluxo 201→200→200 correto em memória |
| Tricky de URL (espaço, unicode, fragmento, maiúsculas, trim, IDN, query gigante, `@` no path) | todos normalizados corretamente; fragmento removido; `user@host` como userinfo bloqueado, `@` no path permitido |

---

## Apêndice — o que foi executado

- `scripts/source-battery.mjs` (novo, mantido no repo): 62 casos de URL ×
  6 passos (`parseUrlStrict`, `isArticleUrl`, `fetchMediaContext`, `probeOEmbed`,
  `probeOpenGraph`, `fetchDocument`) + 8 uploads. JSON em
  `tmp-dl/source-battery-full.json` (62) e `tmp-dl/source-battery-quick.json` (17).
- Sondas dirigidas: `safeFetch` hostil (teto declarado/real, truncate, redirect
  relativo, timeout, budget), artigo controlado (`full`/`paywall`/`metadata-only`/
  captcha/`non-html`/loop), `og:video` direto, `enforceDuration`, downloads reais
  YouTube/TikTok/X (áudio+frames), `yt-dlp` exit-code bissecção, colisão paralela,
  scoring (20 mutações), evidence null-safety, `locateQuote`/`textFromHtml` perf,
  uploads (24 casos), endpoint (método/kind/vazio/privado/longo/triage/não-HTTP),
  limits (rate/slot/budget/reconcile/modos), `clientIp` (9), correções (fluxo),
  admin (auth + ações GET/POST), moderação (triage + decide).
- `npm test`: 71/71 antes e depois (nenhuma alteração de produção feita).
- Arquivos temporários da bateria removidos de `tmp-dl/test-media` (só `video.mp4`
  pré-existente permaneceu); JSONs da bateria em `tmp-dl/` (ignorado pelo git).
