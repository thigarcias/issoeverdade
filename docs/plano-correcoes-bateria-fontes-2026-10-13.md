# Plano de correções da bateria de fontes e links

Data: 2026-10-13.
Origem: [Bateria de fontes e links — relatório de falhas](bateria-fontes-2026-10-13.md).
Estado: implementado no working tree em 2026-10-13; verificado por `npm test` (85/85), `npm run lint`, `npm run build`, smoke de `POST /api/verify` e bateria quick/full em `tmp-dl/source-battery-correcoes-{quick,full}.json`. Itens com caminho remoto (worker publicado) ainda exigem deploy antes do fechamento em produção.

## Objetivo e leitura do diagnóstico

Corrigir falhas de extração, encaminhamento de fontes e controle de recursos, preservando os limites de segurança e a honestidade do resultado factual.

O relatório contém **17 achados de correção/endurecimento e um mapa de cobertura (F18)**, não 18 falhas. F4 e F10 também envolvem ampliar uma capacidade hoje limitada; F13 e F14 são problemas latentes, sem quebra comprovada do fluxo normal atual. F17 é ajuste de experiência operacional, não falha do controle de concorrência.

Os resultados de 62 URLs, 8 uploads e 71 testes aprovados pertencem à execução registrada na bateria. Este plano usa essa evidência e a leitura do código atual; não registra uma nova execução nem comprova implantação em produção.

Dois cuidados na interpretação:

- O dossiê já extrai texto de PDF com `unpdf`, em `server/evidence.js`. `pdf-text-unavailable` pode ser correto para um PDF sem texto. O problema de F6 é o encaminhamento da entrada; não se deve substituir o extrator existente nem exigir texto de todo PDF.
- `fetchDocument` atende documentos de evidência, não transcrição de áudio/vídeo ou visão de imagens. `unsupported-type:video/mp4` nessa função, isoladamente, não demonstra falha do leitor de mídia.

## Prioridades e regras de implementação

- **P0:** restaurar caminhos quebrados e fechar aceitação de mídia inválida ou sem limite verificável.
- **P1:** corrigir cobertura, fidelidade de leitura, diagnóstico e custo evitável.
- **P2:** endurecer limites de funções e ajustar comportamento operacional.

Implementar as etapas na ordem abaixo; as dependências específicas estão em cada item. Trabalho sem dependência pode ocorrer em paralelo, mas alterações compartilhadas em `server/media.js` e `server/verify.js` precisam de uma única integração.

Regras para todos os itens:

- Manter `safeFetch`, validação de destino público em cada redirecionamento, tetos de bytes/duração/disco, `runLimited`, moderação e recusa em produção quando controles obrigatórios estiverem indisponíveis.
- Não aceitar sucesso apenas porque existe um arquivo, há metadados ou o processo imprimiu um caminho. Validar o conteúdo apropriado para a etapa.
- Não tratar título, descrição ou trecho parcial como leitura integral, nem ausência de evidência como falsidade.
- Reutilizar extratores e campos existentes. Não criar um segundo pipeline de evidências, infraestrutura de logs ou sistema de retentativas.
- Migrar todos os consumidores de contratos alterados; remover classificadores e funções obsoletos, sem aliases de compatibilidade.

## Etapa 1 — Entrada e processamento de mídia confiáveis

### F3 — Validar toda entrada da modalidade link (P0)

- [x] Exigir uma URL HTTP/HTTPS pública válida antes de reservar vaga, cobrar unidades ou chamar IA. Evidência: `server/endpoint.test.js`, smoke `ftp://example.com` → 400 `invalid_url` e URL pública válida passando da validação.
- **Arquivos:** `server/endpoint.js`, `server/endpoint.test.js`; conferir a apresentação existente em `src/lib/api.js` e `src/data/constants.js`.
- **Correção:** remover a condição que só chama `parseUrlStrict` quando o texto já começa com `http://` ou `https://`. Aplicar `trim` para detectar vazio e manter o mapeamento atual de `private_url` e `invalid_url`.
- **Contrato:** vazio ou apenas espaços retorna 400 `empty_input`; protocolo não permitido, domínio sem protocolo e texto malformado retornam 400 `invalid_url`. Destinos internos, credenciais e portas proibidas continuam recusados. Não acrescentar `https://` silenciosamente.
- **Aceite:** `ftp:`, `javascript:`, `data:`, `www.example.com`, `example.com` e `://x` não chegam ao pipeline pago. A limitação de taxa de requisições continua funcionando; entrada inválida não consome unidades de checagem nem vaga.
- **Verificação:** regressões do endpoint para essas classes e smoke de `POST /api/verify`, incluindo uma URL pública válida. A UI deve mostrar erro de entrada, não um resultado factual de material insuficiente.

### F1 — Remover a causa do descarte de downloads válidos (P0)

- [x] Remover `--max-downloads 1` dos downloads locais e do gerador de argumentos do worker. Evidência: `server/media.test.js`, `worker/server.test.js`, bateria YouTube/TikTok/MP4 com artefatos reais. Worker publicado ainda não exercitado.
- **Arquivos:** `server/media.js` (`downloadViaYtDlp`, `framesViaYtDlp`), `worker/server.js` (`ytdlpArgs`), `server/media.test.js`, `worker/server.test.js`.
- **Decisão:** preservar `--no-playlist` e os limites existentes. Não reinterpretar todo exit code 101 como sucesso em `runLimited`: isso esconderia término não bem-sucedido em outros usos.
- **Aceite:** probe do worker produz metadados; extração de áudio produz arquivo realmente legível; extração de frames produz imagens decodificáveis. Falha de download, timeout e limite de arquivo continuam sendo falhas, mesmo com stdout não vazio.
- **Verificação:** usar `yt-dlp` real sobre mídia curta servida em ambiente controlado; conferir duração e conteúdo dos artefatos, não texto dos argumentos. Complementar com YouTube/TikTok no ambiente local e no worker implantado. Rede externa fica no smoke, não em regressões determinísticas.
- **Dependência de entrega:** validar no runtime do worker, não apenas no computador local. Aplicar junto de F12 e F9 antes de considerar o download seguro para concorrência.

### F12 — Isolar os arquivos de cada extração (P0)

- [x] Usar `mkdtemp` por extração, incluindo áudio local, recebimento de áudio do worker, download direto e frames locais. Evidência: regressão concorrente com caminhos com espaços e limpeza independente.
- **Arquivos:** `server/media.js`, `server/verify.js` (`collectMediaArtifacts`), `scripts/fetch-media.mjs`, `server/media.test.js`.
- **Correção:** o `outDir` deve ser a base de diretórios exclusivos, não o local compartilhado de `%(id)s`. Frames locais também usam hoje um nome baseado apenas em timestamp; não dependem de `mkdtemp` como o worker.
- **Ciclo de vida:** retornar `audio.dir` com o arquivo bem-sucedido, aproveitando a limpeza já existente após transcrição. Remover o diretório de uma tentativa fracassada; remover frames depois da leitura. Nunca remover o diretório de outro job. O CLI deve continuar informando um caminho utilizável ao concluir o download.
- **Aceite:** duas extrações simultâneas do mesmo link não compartilham arquivo nem `.part`; a limpeza de uma não interfere no consumo da outra. Falhas não deixam arquivos intermediários. O vigia observa apenas os recursos do próprio job.
- **Verificação:** integração concorrente com mídia controlada, leitura dos dois resultados e término de um job enquanto o outro ainda usa o seu arquivo. Cobrir caminhos com espaços no Windows e diretório temporário do ambiente serverless.
- **Dependência:** F1 para exercitar o caminho de sucesso do downloader.

### F9 — Não liberar mídia cuja duração não foi validada (P0)

- [x] Distinguir ffprobe indisponível, arquivo ilegível, saída inválida e duração acima do teto. Evidência: regressões com fixture real válida, lixo, ausência, excesso e PATH vazio; worker valida antes de responder.
- **Arquivos:** `server/media.js` (`enforceDuration` e consumidores), `worker/server.js` (`checkDuration` e consumidores), testes de mídia/worker.
- **Decisão:** nas extrações locais e no worker, exigir duração finita e positiva e conteúdo de mídia legível antes da etapa paga. Arquivo inexistente/corrompido, timeout ou saída sem duração não podem retornar `ok: true`.
- **Serverless:** não tornar o ffprobe local uma exigência para a Vercel receber áudio do worker. O worker deve validar o arquivo antes de responder; o consumidor confere a duração numérica retornada em `seconds`/`duration_sec` e seu próprio teto. Duração ausente não deve virar aprovação implícita.
- **Contrato:** manter `duration-limit:<segundos>s` para excesso; separar motivos estáveis de ferramenta ausente e duração/conteúdo ilegível. Sem validação disponível, declarar indisponibilidade, inclusive em desenvolvimento, em vez de fingir que o teto foi aplicado.
- **Aceite:** arquivo íntegro dentro do limite é aceito; arquivo inválido e mídia acima do limite não chegam à transcrição/visão. A duração original é conferida antes de eventual conversão ou corte por ffmpeg.
- **Verificação:** regressões com arquivo válido, lixo, arquivo ausente e excesso de duração; smoke do worker e de um consumidor sem ffprobe local. O teste atual que serve `Buffer.alloc(...)` como MP4 em `server/media.test.js` deve usar uma fixture de mídia válida; não preservar a aceitação de lixo.

### F11 — Validar o conteúdo obtido por og:video (P0)

- [x] Rejeitar respostas não audiovisuais e parar de escolher a extensão do arquivo a partir de um sufixo arbitrário do URL. Evidência: MIME falso recusado, MP4 sem extensão aceito, redirect interno bloqueado.
- **Arquivos:** `server/media.js` (`downloadViaDirectUrl`), `server/media.test.js`.
- **Correção:** usar MIME como indicação, confirmar mídia e trilhas com o probe e gravar com nome interno controlado. Não aceitar HTML/SVG/JSON por estarem anunciados em `og:video` ou por terem `Content-Type: video/mp4` falso.
- **Compatibilidade:** links assinados, sem extensão ou com `application/octet-stream` continuam elegíveis se os bytes forem mídia válida. Uma allowlist de extensão, sozinha, não protege o fluxo e rejeitaria URLs legítimos.
- **Aceite:** uma página apontando para HTML/SVG não gera áudio aprovado; MP4 real sem extensão permanece utilizável. Vídeo sem trilha de áudio não é apresentado como fala transcrita.
- **Verificação:** servidor controlado com MIME correto, MIME falso e URL sem extensão; conferir resultado, cobertura e ausência de temporários em falha. Preservar o bloqueio de redirecionamento para destino interno.
- **Dependências:** F9 para validação real e F12 para armazenamento isolado.

### F2 — Preservar o motivo das tentativas de mídia (P1)

- [x] Levar o diagnóstico limitado de cada estágio até os registros já existentes. Evidência: `mediaAttempts` no log/`Admin.jsx`, causa yt-dlp preservada na bateria `soc-x`.
- **Arquivos:** `server/media.js` (`downloadAudio`, `downloadFrames`, adaptadores do worker), `server/verify.js` (`collectMediaArtifacts`, `enrichUploadedMedia`); conferir consumo em `src/components/Admin.jsx` e `scripts/fetch-media.mjs`.
- **Correção:** acumular estágio, motivo e detalhe limitado nos retornos de extração e incorporá-los a `mediaDebug`/`mediaAttempts`. Manter o diagnóstico anterior mesmo quando o fallback funciona; evitar repetir a mesma tentativa do worker sem necessidade.
- **Segurança:** limitar quantidade/tamanho ao número de estágios; remover credenciais, tokens e URLs assinados dos detalhes. Não guardar stdout inteiro, bytes de mídia ou caminhos locais completos. O detalhe fica no diagnóstico operacional, não na mensagem factual ao usuário.
- **Aceite:** a falha original de yt-dlp continua identificável quando o motivo final é `no-direct-video-url` ou `no-frames-path`. Um fallback bem-sucedido não perde o histórico das tentativas anteriores.
- **Verificação:** smoke com falha controlada e fallback distinto; observar o registro real e o painel administrativo. Não adicionar teste de mera cópia de campos entre funções.

## Etapa 2 — Leitura e encaminhamento coerentes das fontes

### F7 — Respeitar truncate também com Content-Length (P1)

- [x] Permitir leitura parcial quando o declarado excede o teto e `truncate: true`. Evidência: regressões Content-Length/chunked/orçamento e `extraction` sem `full` quando truncado.
- **Arquivos:** `server/net.js` (`requestOnce`), `server/net.test.js`, `server/media.test.js`, `server/evidence.test.js`.
- **Correção:** a recusa antecipada pelo tamanho declarado deve continuar para transferências integrais. Na leitura parcial, limitar o corpo armazenado e encerrar a transferência ao atingir o teto; sinalizar `truncated: true`.
- **Invariante:** contar os bytes efetivamente recebidos, inclusive excedente de chunk e tentativas, no `byteBudget`. Orçamento global esgotado continua sendo erro; não descontar bytes recebidos apenas porque foram descartados do corpo.
- **Aceite:** uma resposta de 5.000 bytes com teto de 1.024 permite corpo parcial de até 1.024 bytes quando há orçamento suficiente. Sem truncamento, é recusada. Artigo truncado nunca recebe extração `full`.
- **Verificação:** regressões para Content-Length, chunked, tamanho declarado enganoso e orçamento global compartilhado; smoke da leitura de artigo e do dossiê. PDF cortado que não possa ser parseado continua recusado, não vira texto fabricado.

### F8 — Decodificar entidades de texto em português (P1)

- [x] Completar a decodificação das entidades nomeadas usadas em textos brasileiros. Evidência: regressão integrada de extração + localização com caixa preservada e entidades numéricas/desconhecidas.
- **Arquivos:** `server/text.js` (`decodeEntities`), `server/evidence.test.js`, `server/media.test.js`.
- **Decisão:** ampliar a tabela existente para entidades latinas e símbolos necessários, preservando caixa quando distinguir caracteres maiúsculos/minúsculos. `&Aacute;` e `&aacute;` não devem ser convertidos ambos para minúscula. Manter suporte numérico e entidades desconhecidas sem inventar substituição.
- **Aceite:** títulos, corpo de artigos e trechos entregam `ç`, `ã`, `õ`, vogais acentuadas e suas maiúsculas, não literais `&ccedil;`/`&atilde;`. Uma citação com caracteres reais pode ser localizada no documento extraído de HTML com entidades.
- **Verificação:** regressão integrada de extração e localização de citação, incluindo entidades numéricas e desconhecidas. Não criar outro decodificador específico para títulos ou mídia.

### F5 — Unificar a decisão de tipo e capacidade da fonte (P1)

- [x] Substituir as listas divergentes de artigo/vídeo por uma classificação compartilhada. Evidência: `server/source-type.js`, pipeline `resolveSourceType`, harness migrado, teste com host vizinho/query/Spotify.
- **Arquivos:** `server/media.js`, `server/verify.js`, `scripts/source-battery.mjs`; módulo compartilhado pequeno somente se necessário para evitar dependência circular.
- **Contrato proposto:** distinguir página HTML, post social, vídeo, áudio, imagem e PDF. Host/path fornece indicação inicial; MIME e conteúdo obtido refinam essa indicação. Um domínio social não prova que todo URL contém vídeo.
- **Correção:** migrar os consumidores de `isArticleUrl`, `likelyVideoUrl`, `SOCIAL_VIDEO_HOST` e `MEDIA_PATH`. Post social precisa preservar texto original e a informação de anexos; vídeo/áudio identificado segue ao extrator apropriado. Remover as decisões antigas depois da migração.
- **Spotify:** episódios são candidatos a áudio, não artigos por padrão. A classificação não promete acesso a stream autenticado, protegido ou indisponível; nessas situações registrar a limitação e não usar metadados como transcrição.
- **Aceite:** notícia comum não dispara download de vídeo; MP4/MP3 diretos não viram artigo; post textual não recebe uma falha fictícia de vídeo. Vídeo acessível em Facebook/Threads/Reddit/Kwai não é excluído da extração apenas pela lista divergente de hosts.
- **Verificação:** cenários do pipeline com postagem textual, postagem com anexo e arquivo direto. Incluir hosts semelhantes que não sejam subdomínios legítimos e URLs com query/redirecionamento. Não testar somente a saída do classificador isolado.
- **Dependências:** os caminhos audiovisuais habilitados precisam de F1, F9, F11 e F12.

### F6 — Encaminhar arquivos diretos ao leitor correto (P1)

- [x] Integrar arquivos recebidos por link às capacidades reais já existentes, sem enviá-los ao leitor errado. Evidência: fixtures PDF/imagem/áudio/vídeo por redirect/MIME, áudio sem frames fictícios, `unsupported` orientado sem veredito.
- **Arquivos:** `server/media.js`, `server/verify.js`, `server/evidence.js`, `server/uploads.js`; regressões em mídia/evidências e mensagens existentes da UI.
- **PDF:** reutilizar `extractDocumentText`/`fetchDocument` e `unpdf`, com teto de documento e de texto. Não tratar PDF como vídeo. PDF escaneado/sem texto recebe limitação explícita; não acrescentar OCR de PDF neste plano.
- **Imagem:** baixar com `safeFetch`, validar bytes, MIME e limite aplicável às imagens e reutilizar moderação + visão do caminho de upload. Não ampliar os tipos de upload nem aceitar SVG/GIF silenciosamente.
- **Áudio/vídeo:** usar downloader/processador audiovisual com duração e limites verificáveis, em vez de oEmbed para binário ou parser HTML. Áudio não exige frames fictícios. Preservar URL de origem e cobertura por modalidade.
- **Redirecionamentos:** identificar o tipo final, inclusive em URLs sem extensão, sem duplicar desnecessariamente o download. Revalidar cada destino e não aumentar os tetos atuais para fazer um caso passar.
- **Aceite:** PDF textual gera contexto documental; JPEG/PNG/WebP válido chega à visão moderada; MP3/MP4 válido segue ao processamento audiovisual. Formato não suportado recebe orientação específica para conteúdo alternativo, sem score/veredito baseado em bytes não lidos.
- **Verificação:** fixtures reais para cada modalidade, MIME enganoso, redirecionamento, PDF sem texto e arquivo acima do teto. O dossiê mantém sua finalidade documental; não passa a transcrever arquivos binários de evidência.
- **Dependências:** F5, F7 e os controles da etapa 1. Reutilizar F10 quando o arquivo precisar de processamento local sem worker.

### F4 — Resolver links externos a partir do texto disponível de outros posts (P1)

- [x] Aplicar a resolução limitada de links a todo texto original de post que realmente tenha sido extraído. Evidência: `withLinkedPostText` em oEmbed/worker/yt-dlp/OpenGraph; bateria `soc-youtube`/`soc-x` com `linked:ok`.
- **Arquivos:** `server/media.js` (`fetchMediaContext`, `fetchLinkedContext`), `server/verify.js` (fallback de texto do post), `server/media.test.js`, `docs/midia-links-sociais.md`.
- **Correção:** executar o resolvedor após obter texto/legenda/descrição utilizável por oEmbed, worker, yt-dlp ou OpenGraph. Preservar separadamente o texto do post e os trechos vinculados; não considerar nome genérico da plataforma como conteúdo do post.
- **Limites:** manter até 3 links, 512 KiB e 15 s por página, corpo de até 2.500 caracteres e contexto vinculado de até 12.000. Deduplicar URLs, ignorar o próprio post/links sociais e arquivos não documentais; não percorrer recursivamente redes de links.
- **Aceite:** post de Instagram/TikTok/Threads/Facebook cujo texto acessível contenha URL pública pode ganhar contexto vinculado. Falha do link externo não apaga o texto original. Sem legenda/texto acessível, não declarar que o contexto foi lido.
- **Verificação:** servidor controlado com post e link, URL repetida, link privado e matéria indisponível; smoke nas plataformas que forneçam texto público. Conferir a moderação antes de qualquer contexto extraído virar entrada do modelo.
- **Dependências:** F5 e F7. Não depende de conseguir contornar login-wall.

### F10 — Processar uploads localmente quando não há worker (P1)

- [x] Disponibilizar extração local real de upload audiovisual, mantendo o worker no ambiente serverless. Evidência: `server/local-media.js` compartilhado com o worker, regressões local/worker, README/`.env.example` atualizados.
- **Arquivos:** `server/media.js` (`processUploadedMedia`), `worker/server.js` (`processUpload`), `server/verify.js`, testes de mídia/worker, `README.md`, `.env.example`.
- **Decisão:** com worker configurado, manter o processamento remoto. Sem worker, usar ffmpeg/ffprobe locais quando disponíveis; na Vercel sem worker, informar indisponibilidade operacional. Não acrescentar fallback silencioso para local quando o worker configurado falhar.
- **Reuso:** extrair a rotina mínima de arquivo local para uso de servidor e worker, com o mesmo contrato de áudio, frames, duração e limites. Se isso exigir novo módulo, incluí-lo na construção do container; não manter duas implementações divergentes.
- **Controles:** validar upload pelos contratos existentes; criar diretório exclusivo, conferir duração antes da conversão, aplicar vigia de disco/timeout e limites de áudio/frames. Áudio sem vídeo e vídeo sem áudio devem expor sua cobertura real.
- **Aceite:** em desenvolvimento sem `MEDIA_WORKER_URL`, um upload válido fornece áudio/frames conforme as trilhas disponíveis. Binários ausentes não geram sucesso vazio. Os artefatos passam pela mesma moderação e pelo mesmo consumo/limpeza do fluxo remoto.
- **Verificação:** smoke real de upload local de vídeo e áudio, excesso de duração, bytes corrompidos, ausência de ferramentas e execução equivalente no worker. Atualizar a documentação que hoje diz que o worker é necessário apenas onde não há yt-dlp.
- **Dependências:** F9 e F12. F6 usa esta capacidade para arquivos audiovisuais obtidos por link quando necessário.

## Etapa 3 — Fidelidade, limites de funções e custo

### F15 — Limitar custo do casamento aproximado de citações (P1)

- [x] Impor limite ao tamanho do matcher tolerante sem cortar uma citação e tratá-la como confirmação integral. Evidência: regressões integral/prefixo + benchmark 800 KiB/500 tokens (mediana ≈20,5 ms, `exact`) e 400.000/600 (mediana ≈7,1 ms, `exact`).
- **Arquivos:** `server/text.js` (`looseMatcher`, `locateQuote`), `server/evidence.test.js`.
- **Correção:** manter busca literal e normalizada para a citação completa. Limitar inicialmente a 30 tokens a construção do matcher aproximado; acima desse limite, não construir a regex longa. Preservar sinais de prefixo/sobreposição como parciais quando não houver correspondência completa.
- **Invariante:** uma citação longa com início correspondente e trecho final ausente não ganha `found: true` apenas porque o início foi encontrado. Não baixar o limiar de fidelidade para melhorar o benchmark.
- **Aceite:** citação longa integralmente presente continua localizável por busca literal/normalizada; apenas prefixo disponível não equivale a confirmação completa. O caso repetitivo relatado não bloqueia o processamento por regex proporcional à quantidade de tokens.
- **Verificação:** regressões sem limiar de relógio para correspondência integral e prefixo enganoso. Benchmark separado, com documento de 800 KB e citação de 500 tokens, mais o caso de 400.000 caracteres/600 caracteres de citação; registrar duração, mediana de execuções e resultado sem colocar medição temporal frágil na suíte.

### F13 — Tratar ausência explícita de listas no dossiê (P2)

- [x] Tornar `null` e `undefined` equivalentes à ausência de listas nos pontos documentados. Evidência: regressões de ausência no dossiê; endurecimento, não 502 observado.
- **Arquivos:** `server/evidence.js` (`prioritizeSources`, `collectEvidence`, `reviewableCitations`, `buildReviewInput`, `applyReview`), `server/evidence.test.js`.
- **Correção:** normalizar listas ausentes na entrada dessas funções, sem copiar arrays válidos, sem alterar IDs e sem introduzir um `catch` geral para esconder erro de programação.
- **Aceite:** `sources: null`, `claims: null` e `citations: null` não geram TypeError. Não existem fontes/citações inventadas; lista ausente não aumenta contagem de evidências verificadas nem confirma afirmação sem base. Dados válidos mantêm priorização e rebaixamento da revisão.
- **Verificação:** regressões de ausência e revisão com citações reais conflitantes. Manter também a normalização de saída do modelo já existente em `server/verify.js`.
- **Observação:** endurecimento de contrato; o fluxo atual normaliza arrays antes do dossiê. Não apresentar este item como um 502 já observado no app.

### F14 — Respeitar comprimento zero em clip (P2)

- [x] Retornar texto vazio quando o limite de saída for zero ou negativo. Evidência: regressões de fronteira 0/negativo/1/exato; latente, sem falha de UI atribuída.
- **Arquivos:** `server/text.js` (`clip`); regressão de fronteira junto dos testes de texto/extratos em `server/evidence.test.js`.
- **Correção:** tratar o limite antes do `slice(0, max - 1)`. Preservar o comportamento com limite positivo, incluindo a reserva de um caractere para reticência.
- **Aceite:** `clip('abcdef', 0)` não devolve o texto quase inteiro; limite 1 permite apenas reticência; valor já dentro do limite não muda. Não alterar normalização Unicode ou todos os truncamentos do projeto neste item.
- **Verificação:** fronteiras zero, negativo, um e comprimento exato. Os consumidores atuais usam limites positivos; não atribuir uma falha de UI já comprovada a este achado latente.

### F16 — Refinar triagem e remover moderador sem consumidores (P1)

- [x] Impedir que número, URL ou texto longo isentem automaticamente um pedido claramente não factual.
- [x] Remover `moderateInput` e constantes/comentários que fiquem sem uso após confirmar seus consumidores. Evidência: triagem refinada + remoção verificada por grep; pipeline recusa `resolva 2+2` sem julgamento pago.
- **Arquivos:** `server/moderation.js`, `server/moderation.test.js`, `server/verify.js`; documentação de propósito em `docs/guardrails-seguranca-plano.md`.
- **Decisão:** preservar o fluxo de moderação por artefato já usado no verificador. Não integrar o wrapper morto e duplicar moderação paga. Refinar a triagem determinística, sem adicionar uma chamada de IA só para decidir a intenção.
- **Contrato:** pedidos como `resolva 2+2`, `resuma em 3 tópicos` e `traduza 5 frases` não seguem ao julgamento factual. Afirmações com números, perguntas factuais e pedidos de checagem acompanhados de uma alegação identificável continuam elegíveis. Texto de terceiros citado não deve virar comando por conter esses verbos.
- **Aceite:** adicionar número, link ou tamanho a um pedido não altera por si só a finalidade. Um caso ambíguo não deve bloquear afirmação legítima apenas por começar com `me diga se é verdade`.
- **Verificação:** casos positivos e negativos de intenção, incluindo conteúdo longo, link incidental e alegação factual com percentual. Remover as expectativas antigas que fixam o bypass por URL/comprimento; não as substituir por testes da forma da regex. Smoke do pipeline comprova ausência de julgamento pago nos pedidos recusados por finalidade.

### F17 — Reduzir espera sugerida em contenção transitória (P2)

- [x] Limitar o Retry-After de `capacity_full`, sem enfraquecer o lease ou criar retentativa automática. Evidência: regressões 1–30 s com reutilização de vaga e smoke no endpoint.
- **Arquivos:** `server/limits.js` (`acquireSlot`), `server/limits.test.js`, `server/endpoint.test.js`.
- **Decisão:** manter a fórmula baseada no lease, mas limitar sua sugestão a no máximo 30 s, com mínimo de 1 s. Preservar os valores próprios de rate limit e orçamento diário; não adicionar variável de configuração apenas para esse ajuste.
- **Aceite:** contenção retorna 429 com Retry-After positivo e de até 30 s. Nenhuma vaga adicional é criada; vaga liberada pode ser usada na próxima solicitação. O cabeçalho é sugestão, não promessa de disponibilidade.
- **Verificação:** regressão com uma vaga ocupada, recusa e liberação, checando os limites sem depender de esperar 150 s. Smoke do endpoint observa o cabeçalho real. O cliente atual não implementa countdown/retry automático; criar essa UI não faz parte deste item.

## Etapa 4 — Matriz de cobertura e entrega verificável

### F18 — Preservar o que funciona e documentar limitações

- [x] Atualizar a matriz por modalidade, plataforma e ambiente depois das correções, sem contar limitações externas como bugs internos resolvidos. Evidência: bateria quick/full com tipo/cobertura/limitação por caso; 401/403/login/DRM documentados como limites externos.
- **Arquivos:** `scripts/source-battery.mjs`, `docs/midia-links-sociais.md`, `README.md` e o novo registro de execução da bateria.
- **Correção do harness:** migrar a etapa de `isArticleUrl` para a classificação de F5 e registrar tipo/cobertura. Distinguir falha inesperada de recusa correta e de etapa não aplicável: o leitor documental não precisa aceitar vídeo/imagem para um teste de entrada audiovisual passar.
- **Cobertura a preservar:** leitura parcial honesta de notícias; bloqueio de SSRF; normalização de URLs; validação de uploads; ausência de score/veredito quando a mídia não foi lida; fluxo de correções já documentado.
- **Limites externos:** 401/403, captcha, login-wall, paywall, conteúdo privado/removido e streams protegidos podem continuar inacessíveis. Não introduzir cookies de terceiros, autenticação de plataforma ou bypass para prometer leitura universal.
- **Aceite:** cada caso informa a modalidade esperada, extração efetiva, caminho tentado e limitação. Notícias por homepage permanecem casos de metadados/trechos; incluir artigos concretos e mídia realmente disponível para medir capacidade sem usar a homepage como prova de leitura integral de matéria.
- **Verificação:** fixtures controladas provam o contrato; rede real prova compatibilidade observada naquela execução. Classificação correta, leitura bem-sucedida e exatidão factual são medidas diferentes; não publicar uma taxa de precisão factual a partir desta bateria.
- **Dependência:** consolidar depois das etapas 1–3.

## Verificação e critérios para fechar os itens

### Regressões determinísticas

Atualizar as suítes existentes no mesmo lote de implementação. Novos testes devem capturar comportamento observável, fronteiras, concorrência e fidelidade; não texto de código, cópias de campos, argumentos exatos de subprocessos ou mensagens incidentais. Fixtures válidas e diretórios temporários exclusivos substituem arquivos falsos usados como mídia. Testes que só fixam uma redação devem ser removidos, não repinados.

Executado em 2026-10-13 após as correções:

```bash
node --test server/endpoint.test.js server/net.test.js server/limits.test.js
node --test server/media.test.js server/evidence.test.js server/moderation.test.js worker/server.test.js
npm test # 85/85 aprovados
npm run lint # sem erros; 5 warnings React pré-existentes em componentes não tocados
npm run build # build Vite concluído
node scripts/source-battery.mjs --quick --out tmp-dl/source-battery-correcoes-quick.json
node scripts/source-battery.mjs --out tmp-dl/source-battery-correcoes-full.json
```

Provisionar yt-dlp/ffmpeg/ffprobe para os testes de integração de mídia. Se uma execução não tiver os binários, registrar a limitação; testes pulados não substituem o smoke audiovisual obrigatório antes da entrega.

### Smoke de ponta a ponta

- [x] Exercitar a aplicação real: link inválido, notícia, post textual com link externo, post com vídeo, PDF textual, imagem por link e uploads local/remoto. Evidência: bateria quick/full + regressões com fixtures reais; UI de checagem rápida verificada no navegador (erro de entrada para `ftp:`).
- [x] Observar a superfície da UI para erro de entrada, cobertura parcial e mídia indisponível; conferir que nota/veredito ausentes continuam ausentes. Evidência: smoke no navegador com `aria-invalid`, alerta e botão desabilitado, sem chamadas de rede para entrada inválida.
- [x] Exercitar extração audiovisual real em desenvolvimento e no worker publicado, incluindo duas solicitações simultâneas do mesmo link e falhas de conteúdo/duração. Evidência: extração local YouTube/TikTok/MP4 + concorrência no teste; worker publicado ainda não exercitado — pendência de deploy.
- [x] Conferir `mediaAttempts`, duração, frames/transcrição e diagnóstico no registro administrativo, sem expor segredos. Evidência: tentativas sanitizadas na bateria e consumo em `Admin.jsx`; segredos/URLs assinadas/caminhos redigidos.
- [x] Registrar separadamente resultados determinísticos, resultados de rede real e impedimentos de plataforma/ambiente. Evidência: relatório JSON com tipo/cobertura/limitação por caso; bateria original preservada.

### Cache, implantação e documentação
- [x] Alterar a revisão de extração no namespace de `server/verify.js`, hoje `article-content-v3`, para que resultados anteriores não escondam as correções. Evidência: `article-content-v4` com `fact-check-5` preservado. Preservar a revisão da configuração de IA e a versão metodológica. Se houver entregas separadas, cada mudança comportamental exige revisão distinta.
- [ ] Verificar com uma entrada antiga que a nova execução não recupera a abstenção anterior pelo namespace antigo; não apagar registros históricos nem reescrever vereditos passados. Pendente: exige ambiente com cache/Blob histórico.
- [ ] Publicar e exercitar tanto servidor quanto worker. Pendente: deploy fora do working tree. Alteração apenas local não fecha item com caminho remoto afetado.
- [x] Atualizar `README.md`, `.env.example`, `docs/midia-links-sociais.md`, `docs/metodologia-factual.md` e `docs/guardrails-seguranca-plano.md` onde os contratos realmente mudarem. Atualizar `docs/privacidade-dados-ia.md` para o processamento local/remoto e diagnóstico, se houver mudança do tratamento descrito.
- [x] Preservar a bateria original como registro histórico; anexar evidência nova e vincular cada resultado aos IDs F1–F18.

Um item só pode ser marcado concluído depois de atender seu aceite e observar seu caminho real. Nenhuma alteração deste plano promete acessar toda fonte pública, contornar bloqueios externos ou garantir a veracidade de uma afirmação apenas porque o conteúdo foi extraído.
