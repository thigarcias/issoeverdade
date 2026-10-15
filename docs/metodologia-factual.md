# Metodologia factual

**Atualizada após implementação do plano.** Esta ferramenta automatiza a análise de afirmações; não substitui apuração, revisão profissional ou julgamento humano. Não há certificação ou afiliação ao IFCN declarada.

## Fluxo efetivo e versão

As novas checagens usam `fact-check-11`. O fluxo configura/cacheia a entrada, aplica triagem de propósito e moderação, extrai mídia quando necessário e executa uma avaliação factual com busca web (`judge`). Notícias podem receber pesquisa direcionada condicional (`article-research`), preservando os gatilhos de pesquisa já existentes; isso não é uma reavaliação obrigatória. Em seguida, o servidor **obtém os documentos das fontes vinculadas para localizar os trechos citados** (`evidence`), calcula comparações anuais documentadas, revisa **o conjunto de evidências de cada claim** com JEV por padrão (`evidence-review`) e valida pontuação/veredito deterministicamente. Não há segunda avaliação factual/de mídia `final` nem chamadas de geração e revisão editoriais. A avaliação factual e a visão usam GPT-6 Luna por padrão; transcrição, moderação e revisão JEV mantêm configurações próprias. Os três seletores ativos são avaliação factual, visão e transcrição. Campos da etapa `final` permanecem legíveis apenas em registros históricos.

Ordem das etapas de segurança: (1) política de URL no endpoint; (2) triagem de propósito (pedido direto ao assistente não é afirmação verificável); (3) moderação de texto/imagem antes das chamadas caras; (4) cobertura de vídeo declarada; (5) moderação da transcrição e dos frames amostrados antes da visão; (6) análise factual; (7) dossiê de evidências; (8) validação e registro.

A entrada do modelo é tratada como material não confiável: instruções embutidas em texto, páginas, OCR e transcrição não devem alterar a tarefa. Isso é uma instrução e uma salvaguarda de prompt, não uma prova de resistência a prompt injection.

A versão e a revisão da configuração integram o namespace do cache, junto da época de invalidação (`iev-cache-v2/epoch.json`): uma correção editorial invalidada pelo painel deixa de servir resultados antigos como versão vigente. Registros antigos não são reexecutados; quando não têm versão de metodologia, o painel os identifica como legados. Um registro preservado descreve aquela execução e não garante que uma execução atual repita a conclusão.

### Entrega por stream e recuperação sem nova inferência

O POST transmite eventos NDJSON `accepted`, `content`, `activity` e um terminal `result` ou `error`. O `checkId` aceito é o mesmo usado na execução, no log e no envelope de resultado; o evento `accepted` também entrega `recoveryToken`, gerado com 32 bytes criptograficamente aleatórios. O cliente mantém o decodificador UTF-8 entre chunks, processa a última linha mesmo sem `\n` no EOF (ou antes de uma falha de leitura) e não descarta um terminal já recebido por perda posterior da conexão. EOF sem terminal não significa sucesso.

Se faltar terminal e houver capacidade recebida, o cliente faz **um GET**, não um novo POST: `GET /api/verify?checkId=...`, segredo apenas em `X-Verify-Recovery`. Não há polling. A resposta é `200 {status:"completed",envelope}`, `202 {status:"pending"}`, `409` para falha ou `404` para capacidade inválida/expirada; falha do armazenamento pode produzir `503` e o controle de taxa, `429`. Pendência ou erro transitório preserva a capacidade para nova consulta **explícita**. Falha definitiva/expiração limpa a capacidade; só a próxima ação explícita pode iniciar nova checagem. O GET nunca inicia inferência, reserva orçamento/vaga de POST ou concilia tokens. Um POST com cache ainda passa pela admissão existente, mas não recontabiliza os tokens do resultado antigo.

A capacidade permanece apenas na memória da interface para a mesma modalidade, texto/contexto e identidade do arquivo. Alterar a entrada ou trocar de arquivo/aba a descarta; o resultado recuperado é anunciado como tal. O token não vai para URL, `localStorage`, histórico, compartilhamento ou logs administrativos. O envelope recuperável fica em Blob **privado** quando configurado, sem fallback silencioso após falha desse Blob, ou em memória limitada a 200 registros quando não há Blob. A chave de armazenamento é um hash de `checkId` e token, não o segredo literal. A autorização expira **30 minutos após a aceitação**; pendência ainda sem conclusão após **5 minutos** responde com falha de prazo. O prazo é lógico, não promessa de apagar fisicamente objetos Blob; memória pode perder registros antes disso por reinício ou limite.

O servidor tenta guardar o resultado antes do terminal. Se apenas essa persistência falhar, ainda entrega o resultado válido com `recoveryAvailable: false`; uma falha de recuperação não transforma uma análise concluída em veredito factual diferente. Recuperação consulta somente o registro autorizado, não busca resultado por entrada nem consulta logs administrativos.

### Notícias e falha de acesso ao artigo

Links de páginas comuns usam extração HTML com `safeFetch`, sem downloader de
vídeo. O registro `mediaCoverage.article` distingue `full` (campo estruturado
articleBody recebido sem corte e sem indicação de paywall), `partial`
(metadados/parágrafos/cortes) e `inaccessible` (falha de acesso/extração).
`full` não comprova integralidade editorial nem autenticidade da página.
Scripts/estilos/navegação são descartados; conteúdo da página permanece dado
não confiável e passa pela moderação. Tetos de bytes, caracteres, redirects e
tempo continuam vigentes; não há execução de JavaScript nem bypass de paywall.

O julgamento de notícias orienta busca web, inclusive se o acesso direto falhar.
OpenAI recebe `tool_choice: required`; OpenCode Go aceita somente a escolha
automática, por isso recebe a exigência nas instruções. Sem chamadas de busca
registradas, com abstenção por conteúdo insuficiente ou com uma resposta legada
`needs_media`/`inaccessible_media`, há uma avaliação adicional de pesquisa.
Isso não garante que o provedor devolva fontes utilizáveis; os diagnósticos de
pesquisa registram o ocorrido. URL, título, publicação/site e trechos orientam
a identificação de alegações, não provam o conteúdo. A síntese declara quando
o artigo integral não foi lido. Uma notícia não termina como mídia inacessível
só por falha de acesso: sem alegações identificáveis, `insufficient_input`;
claims identificados sem evidência suficiente ficam `unproven`. A revisão de
extração `article-content-v4` integra o cache; as regras de perguntas e ações futuras introduzidas em
`fact-check-5` permanecem na metodologia atual `fact-check-11`. Resultados do namespace anterior
continuam históricos, não são apagados nem reaproveitados como cache atual.

#### Evidência local de extração e pesquisa

- URL exercitado:
  `https://veja.abril.com.br/politica/de-olho-no-segundo-turno-pt-fara-atos-com-foco-no-eleitorado-cristao-em-sete-capitais/`.
  A extração retornou `article:full`, título/site VEJA e 1.612 caracteres de
  `articleBody`, sem truncamento. `runVerify` com OpenCode Go/Muse retornou
  `checked`, 5 claims, 3 fontes, score 75 (`mostly_true`); o anúncio dos atos
  em sete capitais permaneceu `unproven`. Foram registradas 10 consultas e
  chamadas reais de busca. A ferramenta do provedor não abriu a página VEJA,
  embora a extração HTTP do servidor tenha funcionado.
- Cenário de acesso negado: servidor HTTP local controlado devolveu 403 para
  URL com o mesmo slug e uma pista de publicação VEJA. Com o modelo real,
  houve 5 consultas/chamadas de pesquisa; resultado `checked/unproven`, score
  35, 1 claim, nenhuma fonte vinculada. A síntese declarou que o artigo não
  foi lido diretamente. A hipótese do slug não foi tratada como comprovação.
- Os testes de endpoint com respostas de modelo controladas exercitam
  `needs_media`, preservação de claims e `insufficient_input` sem score/
  veredito quando nenhuma alegação é identificável.

São observações de execuções locais, não garantia de repetição, integralidade
editorial, qualidade das fontes ou implantação. No smoke VEJA, o dossiê
registrou **0/5 trechos localizados** nos documentos obtidos; a pontuação
observada não equivale a validação humana nem deve ser apresentada como prova
de que todas as fontes/alegações foram confirmadas.

Essas pontuações são históricas, anteriores à abstenção agregada de `fact-check-7`: novas checagens com afirmações sem comprovação ou omitidas não recebem nota global. Os registros acima não foram reexecutados.



### Perguntas, rumores e ações futuras

`fact-check-8` mantém a investigação de hipóteses factuais implícitas em perguntas, inclusive informais, introduzida por `fact-check-5` e preservada em `fact-check-6`/`fact-check-7`. Uma pergunta sobre uma ação futura atribuída a alguém deve levar à busca de declarações, anúncios, propostas ou medidas verificáveis, não à previsão do futuro nem à classificação automática como `no_verifiable_claims`.

O claim deve explicitar a hipótese investigada, sem inventar uma fala ou alvo. Um caso individual não identificado fica em `notCheckedClaims`; isso não impede investigar a alegação geral. Desmentidos antigos são contexto, não refutação automática de uma hipótese atual. Sem evidência adequada, o claim fica `unproven`. Opiniões e previsões puras continuam sem pontuação factual; os controles de segurança não foram relaxados.

Smoke real da pergunta “o lula vai fechar a minha igreja???”: `checked`, claim geral `unproven`, pesquisa sobre declarações/medidas e caso individual registrado como não checado. O desmentido de 2022 foi usado como contexto. Esta execução confirma o caminho exercitado, não garante respostas idênticas em todas as execuções do modelo.


## Fontes e limites de evidência

Uma fonte só permanece quando sua URL HTTP(S) específica aparece em uma anotação `url_citation`, em `web_search_call.action.sources` ou em uma ação `open_page` concluída retornada pelo provedor, não é uma homepage genérica e está vinculada a uma afirmação. A requisição de busca solicita `include: ["web_search_call.action.sources"]`. A pesquisa direcionada condicional pode reutilizar a proveniência da avaliação factual; URLs que aparecem apenas no JSON escrito pelo modelo não são aceitas. URLs inválidas, genéricas, sem proveniência ou sem vínculo são descartadas.

A evidência usa relação `supports`, `refutes` ou `context`, identificador de fonte e trecho. O servidor valida o vínculo estrutural, a relação e um trecho não vazio de pelo menos oito caracteres. Depois da avaliação factual e da eventual pesquisa direcionada, ele **obtém o documento da fonte** (até `IEV_EVIDENCE_MAX_DOCS` por checagem, com teto de bytes por documento e por job), extrai texto de HTML ou PDF e **localiza o trecho citado** por comparação literal, normalizada (sem acentos/caixa) ou aproximada (mesmos tokens com pontuação diferente). O resultado de cada citação é registrado como `exact`, `normalized`, `approximate`, `prefix`, `tokens`, `missing`, `empty_quote`, `document_unavailable` ou `not_fetched`.

O coletor compartilha cache por URL, teto de documentos e orçamento de bytes na checagem; o mesmo documento não é baixado duas vezes. A revisão recebe os trechos localizados, sem promover trechos não localizados a prova. Esgotar o teto mantém `document-limit`; isso não prova falsidade. HTML com `NewsArticle`/`Article` reutiliza a extração de `articleBody`, título e data publicados no JSON-LD; outros scripts continuam descartados. Isso recupera conteúdo fornecido pela página, não autentica a publicação nem contorna paywall.

URLs identificadas como reprodução de vídeo/áudio não passam por extração de HTML como prova de fala: sem transcrição disponível no caminho documental, registram `media-transcript-unavailable`. A pesquisa orienta localizar reportagem textual, documento ou transcrição verificável, sem simular leitura audiovisual. Citações continuam exigindo localização em conteúdo obtido; sem documento apto, o resultado registra a impossibilidade em `claim.note`/`evidenceReview.note` e mantém a abstenção, sem trocar provedor de revisão ou inventar fallback.

Montagens de manchetes podem conter hipótese factual de incompatibilidade entre posições. As regras extraem as falas, a comparação, motivações atribuídas e autoria/fidelidade das publicações separadamente; somente o juízo de caráter fica em `notCheckedClaims`. Datas ausentes não são inventadas. Comparação qualitativa requer documentação dos dois lados no mesmo objeto, alcance, condições e contexto pertinente, mas não exige `comparison` aritmético. A existência de dois títulos autênticos não estabelece automaticamente contradição nem causa eleitoral. Essas regras de modelo reduzem omissões, mas não garantem precisão factual ou uma conclusão sobre uma imagem específica sem pesquisa bem-sucedida.

A revisão adicional recebe **um grupo por claim**, contendo a alegação integral, todos os trechos localizados selecionados e, quando houver, o cálculo determinístico. Trechos diferentes podem documentar operandos diferentes; não se exige que cada citação isolada implique toda a alegação, nem se transferem provas entre claims. A resposta de ambos os provedores usa `{claims:[{claimIndex,verdict,note}]}`, com `verdict` em `supports|refutes|context|unclear`. O servidor registra em `claim.evidenceReview` `verdict`, `verification`, `incomplete`, `evidenceIndices` e `note`. Se o teto de revisão excluiu trechos localizados, `incomplete: true` impede conclusão integral. Respostas ausentes, duplicadas ou inconclusivas não confirmam uma classificação; contexto não basta para verdadeiro/falso. Classificação incompatível com a revisão do grupo, ou comparação inelegível/incompatível com ela, volta para `unproven` com o limite identificado.

A revisão de evidências usa por padrão JEV (`jev-1.13-free`) via OpenCode/SystemOne. `IEV_EVIDENCE_REVIEW_PROVIDER=jev|judge` seleciona explicitamente o provedor; o modelo pode ser configurado por variável de ambiente. Não há fallback automático para outro provedor se a revisão falhar. No modo JEV, uma relação só é aceita com probabilidade máxima de classe de pelo menos **0,8** e separação de pelo menos **0,2** para a segunda classe; resultados ambíguos são inconclusivos, nunca refutação automática. Esses limiares operacionais não demonstram calibração ou precisão factual.

Na revisão agrupada, cada trecho fica `relation: "context"` e registra `verification`: `verified` (localização documental de um trecho incluído em grupo validamente revisado), `unavailable` (documento/trecho ou revisão indisponível) ou `unclear` (há localização e revisão, mas não confirmação válida daquele trecho no conjunto). **`verified` individual não significa que a citação sozinha sustenta/refuta toda a alegação**; a relação semântica está em `claim.evidenceReview`, enquanto `evidenceSupport` resume o suporte elegível. O campo pode estar ausente em dados preliminares ou quando a obtenção de documentos está desabilitada. Nem localização nem revisão autenticam a fonte ou comprovam seu contexto integral. Uma afirmação `unproven` pode ter contexto verificável sem ganhar confirmação ou nota; `coverage` mede apenas o alcance da avaliação.

**Isso não prova que a fonte esteja errada nem que a citação seja fiel ao contexto integral.** Ausência de trecho é limitação registrada, nunca falsidade: paywall, página que exige JavaScript, PDF sem texto extraível, tradução e paráfrase aparecem como `document_unavailable`/`missing`. A revisão por modelo é defesa adicional, não validação humana, e não substitui o corpus humano anotado.

O registro preserva consultas, URLs estruturadas e diagnóstico por etapa: busca não solicitada, nenhuma chamada registrada, chamadas sem URLs rastreáveis ou proveniência disponível. Também preserva contagens de anotações/resultados e IDs/status/tipos/URLs tentadas das chamadas, não o envelope bruto completo ou todo conteúdo de páginas. Tentativa de abertura que falhou não qualifica uma URL como evidência. Uma URL retornada pela ferramenta demonstra proveniência, não pertinência semântica nem prova do trecho. A qualidade da busca e a seleção de fontes primárias ainda podem falhar.

### Comparação temporal

Os prompts distinguem publicação, coleta/referência, rodada anterior/atual, votos totais/válidos, percentuais/pontos percentuais e intenção de voto/rejeição. Datas relativas devem usar a data do material original, não automaticamente a data da checagem. Quando conhecidos, claims e evidências incluem `referencePeriod` com início/fim ISO. O servidor converte suporte/refutação de períodos disjuntos em contexto; sem outra evidência compatível, rebaixa a classificação e substitui a justificativa contraditória. Datas ausentes não são inventadas. Esse controle é estrutural: não valida independentemente as datas nem garante que intervalos sobrepostos sejam semanticamente comparáveis.

#### Aritmética anual com operandos localizados

A proposta `claim.comparison` identifica `metric`, `region`, `unit`, `dataset`, `operator` (`greater_than|less_than|equal`) e exatamente dois `groups`, cada um com `label`, `startYear`, `endYear` e `rows`. Cada linha usa `{year,valueText,numberFormat:"pt-BR"|"en-US",scale:1|1000|1000000,evidenceId,complete:boolean}`. `evidenceId` precisa resolver inequivocamente para um trecho localizado do próprio claim; **não entram operandos sem localização**. Ano, grafia literal do valor e unidade devem estar próximos no trecho; `mil`/`milhão` (ou equivalente aceito) precisa documentar a escala junto ao valor. São aceitos números não negativos, até seis casas decimais e dentro da precisão segura. Anos duplicados, sobrepostos, futuros ou fora do período e escopos declarados incompatíveis invalidam o cálculo.

`row.numberFormat` segue a **fonte**, não o idioma da resposta: `9,001` significa 9001 em `en-US` e 9,001 em `pt-BR`; grafias ambíguas com um separador e três dígitos exigem formato explícito, sem adivinhação. Os rótulos de indicador, região, dataset e grupos podem ser identificadores: não precisam aparecer literalmente na citação. A homogeneidade declarada dos metadados é validação estrutural; a revisão agrupada confere seu significado documental, unidade, universo, local e período. Área de floresta queimada, área de toda vegetação, desmatamento e focos de incêndio não são intercambiáveis.

O servidor soma os operandos com aritmética decimal exata, não com um total proposto pelo modelo. O resultado inclui `status: complete|lower_bound|partial|invalid`, `eligible`, `relation`, `scope`, `reason`, `equalLength` e, por grupo, `total`, `rows` com `value` calculado e `coverage: {expected,available,complete,missingYears}`. `complete` em uma linha significa total anual efetivo; o ano corrente é sempre tratado como incompleto. Totais completos de janelas de durações diferentes aparecem como `scope: "shorter_recorte"`, não como períodos equivalentes. A alegação original não pode ser substituída silenciosamente por uma comparação de recortes menores.

`partial` exibe apenas dados disponíveis, sem extrapolar o restante do ano/mandato, e é inelegível para concluir os períodos completos. `lower_bound` é restrito a **área aditiva não negativa**: um lado incompleto só estabelece a desigualdade se seu subtotal já superar o total completo do outro lado. Não prova igualdade, total completo, previsão, porcentagem ou contagem convertida em área; dois lados incompletos não bastam. Mesmo `complete` ou `lower_bound` só autoriza conclusão quando a revisão documental do grupo confirma a mesma relação no escopo exato da alegação.

### Síntese legível e compartilhamento

As justificativas mantêm fatos e limites em pt-BR, não comentários internos sobre extração de claims, revisão ou ajustes de nota. Pedido, negociação, promessa e recebimento de dinheiro são ações distintas; uma notícia sobre suspeita ou investigação não comprova, por si, o fato investigado. Fontes indiretas e compilações devem ter seu alcance explicado e não substituem automaticamente o documento original. Os trechos citados continuam literais no idioma da fonte; a justificativa explica seu significado em português, sem inventar uma tradução literal.

Em `fact-check-11`, a síntese das checagens avaliadas é construída deterministicamente depois da validação: apresenta contagens por classificação e até três alegações com seus estados finais, sem reutilizar o resumo preliminar do modelo. Afirmações omitidas e limitações de leitura de artigos/posts continuam declaradas. Quando a classificação muda, justificativas incompatíveis não são reaproveitadas: usam os limites documentais consolidados ou a nota da revisão do próprio grupo. Não há geração editorial nem uma segunda chamada para revisar a síntese. Estados sem avaliação factual conservam suas mensagens operacionais.

**Histórico, não fluxo atual:** `fact-check-9` e `fact-check-10` usavam chamadas de geração e revisão editoriais depois da consolidação; `fact-check-10` também revisava justificativas. Esse contrato foi substituído em `fact-check-11`. Os smokes dessas versões ao fim deste documento descrevem somente aquelas execuções.

O PNG e o texto compartilhado usam a alegação efetivamente checada como título, em vez de uma pergunta que possa insinuar um fato mais amplo. O card prioriza a justificativa em português, identifica citações como trechos originais e mantém a fonte atribuída; para uma alegação sem comprovação, o trecho aparece como contexto, não como prova. O texto compartilhado também inclui a síntese e o endereço de correções. Estados sem avaliação factual não recebem nota nem selo de verdade no compartilhamento. O PNG é uma síntese de espaço limitado; o resultado completo conserva as alegações e fontes.

Regressões de contrato estão em `server/scoring.test.js`, `server/evidence.test.js`, `server/verify.test.js`, `server/endpoint.test.js` e `server/share-card.test.js`. Entradas controladas não demonstram precisão factual em casos reais nem substituem revisão humana.



## Resultados, estados e pontuação

Estado operacional e veredito factual são campos distintos:

- `checked`: avaliação concluída com afirmações verificáveis.
- `partial_coverage`: o servidor limitou a lista a 50 afirmações e registrou quantas ficaram de fora.
- `insufficient_input`: material insuficiente para verificar.
- `inaccessible_media`: a mídia necessária não foi acessível ou processada.
- `no_verifiable_claims`: não foi identificada afirmação factual verificável (inclui pedido direto ao assistente).
- `content_refused`: recusa de política de conteúdo (abuso sexual infantil, conteúdo sexual explícito). O material não é analisado nem redistribuído.
- `moderation_uncovered`: vídeo não processado porque a cobertura de moderação de vídeo não foi declarada nesta implantação.
- `error`: falha operacional registrada; não é um veredito.
- `legacy`: registro antigo sem contrato de resultado suficiente.

### Política de conteúdo

Checar afirmações públicas sobre temas difíceis é permitido: menção a violência, ameaça, crime ou discurso sensível **não** é motivo de recusa por si só. A recusa automática é restrita às categorias que não podem ser processadas ou redistribuídas (`sexual/minors` e conteúdo sexual explícito, ajustáveis por `MODERATION_REFUSE_CATEGORIES`/`MODERATION_THRESHOLDS`); outras categorias sinalizadas ficam registradas como sensibilidade, sem bloquear a checagem. O texto trazido da página/post também passa pela moderação antes de virar entrada do modelo.

Em `MODERATION_MODE=required` (padrão em produção), indisponibilidade do serviço de moderação **interrompe a checagem como erro operacional** (`503 moderation_unavailable`) — nunca como recusa de conteúdo nem como veredito factual. Em `optional`, a falha é registrada e a checagem segue.

Para vídeo, a cobertura declarada é **transcrição + até 4 frames amostrados** — não é inspeção integral do arquivo. Sem `MEDIA_VIDEO_MODERATION=partial_frames_transcript`, o processamento de vídeo é recusado em produção até haver decisão explícita de produto.

Quando não há afirmação verificável, entrada suficiente ou mídia acessível, o sistema não deve inventar nota nem veredito. A interface apresenta o motivo sem converter falha de acesso em falsidade. Conteúdo que seja opinião, previsão ou condição fica fora da nota factual.

As notas atuais são determinísticas quando há evidência adequada: `true` **95**, `context` **70** e `false` **5**. O modelo não escolhe a nota; a pontuação não é usada para inferir que as fontes são independentes ou primárias. Um claim `unproven` recebe `score: null`: ausência de nota, não zero, nem prova de falsidade.

O resultado inclui `coverage: { total, assessed, unproven, omitted }`, distinguindo o total de afirmações, as avaliadas com evidência adequada, as sem comprovação e as omitidas. A cobertura mede o alcance da avaliação, não o suporte factual. Cada claim inclui `evidenceSupport`: `supports`, `refutes`, `context` ou `insufficient`, que descreve a relação da evidência com a afirmação.

Suporte e classificação não são aliases: uma alegação ainda não comprovada pode ter `evidenceSupport: "context"` ou trechos de suporte, sem receber nota automaticamente. Trechos indisponíveis/inconclusivos não contam como evidência elegível. Suporte e refutação simultâneos são registrados como relação agregada insuficiente e impedem uma classificação pontuada enquanto o conflito não for resolvido.

Cada afirmação é validada contra suas próprias fontes, texto e período. Não existe segunda avaliação de imagens/vídeos para reformular ou acrescentar claims; uma conclusão sobre outra pergunta não substitui o objeto avaliado. Ausência de suporte documental mantém a abstenção.

Só quando todas as afirmações têm evidência adequada e nenhuma foi omitida o score geral é a média aritmética arredondada das notas. Se houver qualquer claim sem comprovação ou omitido, o resultado se abstém: `score: null`, `verdict: "unproven"`. Afirmações, justificativas e fontes continuam disponíveis na interface e no detalhe; não há anel de nota para um resultado sem nota.

As faixas numéricas continuam disponíveis para resultados apoiados em evidência e para exibir o histórico, sem converter ausência de evidência em uma faixa numérica:

| Score | Rótulo |
| ---: | --- |
| 90–100 | Verdadeiro |
| 75–89 | Maioria verdadeira |
| 65–74 | Parcialmente verdadeiro |
| 55–64 | Distorcido |
| 35–54 | Sem comprovação |
| 15–34 | Enganoso |
| 0–14 | Falso |

A pontuação não é probabilidade calibrada, nem medida de precisão. A média depende de como as afirmações são segmentadas; não há avaliação humana publicada que demonstre validade estatística dessas faixas.

## Imagens, vídeos e uploads

Uploads de imagem/vídeo/áudio respeitam o teto de 3 MiB, assinatura e MIME
compatível; texto acima de `IEV_MAX_TEXT_CHARS` é recusado. O processador
compartilhado (`server/local-media.js`) valida arquivo, trilhas e duração finita
positiva com `ffprobe` antes da conversão. Sem worker, apenas desenvolvimento
usa `ffprobe`/`ffmpeg` locais; em serverless sem worker a extração informa
indisponibilidade. Worker configurado processa remotamente e sua falha não aciona
fallback local. A duração original, `IEV_MAX_MEDIA_SECONDS`, disco, tempo, áudio
e frames permanecem limitados. Áudio sem vídeo não exige frames; vídeo sem áudio
não é apresentado como fala transcrita.

Links são classificados por modalidade após redirects e por indicação de host,
caminho, MIME ou assinatura obtida em amostra. Notícias HTML não disparam
extração audiovisual; post social não prova que exista vídeo. Episódios Spotify
são candidatos a áudio. PDF textual reutiliza `fetchDocument`/`unpdf`; imagem
direta usa `safeFetch`, validação de bytes/MIME e o mesmo caminho de moderação e
visão do upload; áudio/vídeo passa por validação de stream e duração antes de
transcrição ou visão. Formatos não suportados, conteúdo não lido e falhas não
recebem score/veredito com base em metadados.

Quando texto de post está acessível, o resolvedor pode seguir até 3 links
documentais (512 KiB e 15 s por página), limitar o corpo a 2.500 caracteres e
o contexto conjunto a 12.000. Dedupe URLs, ignora o próprio post, links sociais e
arquivos de mídia; não percorre links recursivamente nem contorna login-wall.

A mídia pode falhar parcialmente: transcrição sem timestamps, áudio ausente, OCR/visão indisponível, link inacessível ou frames limitados. A resposta e o painel registram cobertura e tentativas quando disponíveis. Dez frames e uma transcrição não significam cobertura integral. Não há autenticação de autoria, data, montagem ou contexto de uma imagem/vídeo. Links de plataformas dependem dos extratores públicos disponíveis; login-wall, captcha, paywall, conteúdo removido e streams protegidos podem permanecer inacessíveis.

Downloads de metadados, áudio e frames têm subetapas medidas. Depois da extração, transcrição e visão rodam em paralelo; falha de uma não descarta a outra. O painel mostra subetapas e fase principal: elas se sobrepõem e suas durações não devem ser somadas. Quantidade real de frames, timestamps fornecidos e duração retornada pelo worker são preservados, sem inventar timestamps ausentes.


O card compartilhável inclui o **ID da checagem**, a indicação de que a análise é automatizada (e que a nota não é probabilidade calibrada) e o endereço para conferir correções daquele resultado. Cards já baixados não podem ser recolhidos ou atualizados automaticamente: o link é o que permite verificar a versão vigente.

## Avaliação reproduzível

O repositório inclui `scripts/evaluate-factual.mjs`, um harness que lê JSONL e calcula métricas por versão metodológica, configuração de modelo e modalidade. Nenhum corpus humano foi entregue nesta implementação; portanto, **não há benchmark factual de corpus nem taxa de precisão a publicar**. Smokes e comparações operacionais de casos individuais não substituem esse benchmark. A recomendação inicial é reunir pelo menos 200 casos únicos, com cobertura por modalidade e categoria, antes de interpretar métricas como avaliação ampla.

Executar sobre corpus já anotado:

```sh
node scripts/evaluate-factual.mjs ./corpus-human.jsonl
```

Cada linha contém `caseId`, `runId` único, `groupId`, `methodologyVersion`, `modelConfiguration`, `modality`, duas `annotations` com `annotatorId`, `independent: true`, `verdict` e `claims` (listas), `adjudicated` e `prediction`. A adjudicação fornece `verdict`, `claims` (`id`, `verifiable`, `status`), `citations` (o `citationId` previsto e booleanos `relevant`, `relationCorrect`, `quoteSupported`) e `requiredCitations` (`claimId`, `url`). A previsão contém `verdict` (ou `null` para abstenção), claims com `claimId`/`status`, citações com `citationId`, `claimId`, `url`, `relation` e `quote`; `transcriptText` e `ocrText` são opcionais para medir WER.

O relatório inclui matriz de confusão, acurácia e macro-F1, falso positivo acusatório, precisão/recall de abstenção, precisão/recall e macro-F1 de claims, precisão de relevância/suporte de citação, acerto da relação, recall de citações necessárias, WER de transcrição/OCR, estabilidade entre execuções repetidas, concordância/Kappa dos vereditos dos anotadores e intervalos bootstrap de 95% agrupados por `caseId` (1.000 amostras determinísticas). Com menos de dois casos distintos, o intervalo não é calculado. `groupId` identifica casos relacionados e sua quantidade é reportada.

**Tabelas e gates:** o relatório traz tabelas por modalidade e por categoria com `n` por recorte, marcando `SIM (n < 10)` e avisando quando a amostra é insuficiente. `--check-split` falha se algum caso não tiver `split`/`eventId` ou se o mesmo `eventId` aparecer em `dev` e `eval` (vazamento de evento). `--require chave>=valor` (repetível) aplica gates e falha quando a métrica não atinge o valor ou não existe — as chaves válidas são listadas no erro. `publicationWarning` acompanha o JSON para evitar publicar métrica isolada.

**Ferramentas de corpus:** `scripts/corpus-tool.mjs` tem `init` (template), `validate` (schema, enums, `caseId` único, datas e coerência predição↔claims), `agreement` (concordância por campo, Kappa de Cohen e lista de divergências), `adjudicate` (gera `adjudicated` de A/B exigindo decisão para cada divergência) e `split` (divisão determinística por `eventId`, reprodutível). Guia completo em [avaliacao-corpus.md](avaliacao-corpus.md).

`independent: true` e a adjudicação são declarações no corpus: o script valida estrutura e consistência entre execuções, mas não autentica pessoas, independência real, qualidade das anotações, representatividade ou autenticidade das fontes. Atingir 200 casos só cumpre um limiar de volume, não torna o corpus um benchmark representativo. Os casos devem ser anotados por duas pessoas independentemente e adjudicados por uma pessoa competente; modelo de IA não serve como gabarito.

Consulte também [Correções](politica-correcoes.md), [Privacidade](privacidade-dados-ia.md) e o [plano e registro de implementação](admin-overview-plano.md) com o [status por fase](admin-status-implementacao.md).

## Evidência de integração — `fact-check-11`, 14/10/2026

Benchmark local real do [post do Estadão](https://x.com/Estadao/status/2110508020958405042), em três processos com cache novo, na ordem abaixo:

| Fluxo / modelo | Tempo de parede | Tokens reportados | Afirmações / fontes | Resultado |
|---|---:|---:|---:|---|
| Anterior (`fact-check-10`) / GPT-6 Luna | 69.097 ms | 59.227 | 4 / 2 | `checked` / `unproven` |
| Simplificado (`fact-check-11`) / Muse Spark 1.3 | 50.641 ms | 200.452 | 3 / 2 | `checked` / `unproven` |
| Simplificado (`fact-check-11`) / GPT-6 Luna | 34.253 ms | 28.612 | 3 / 1 | `partial_coverage` / `unproven` |

No Luna, a redução observada de tempo foi de **50,43%**. Uma execução por condição não permite estimar desempenho típico nem precisão factual. O campo `totalMs` anterior registrou 54.521 ms porque excluía as chamadas editoriais; os valores novos foram 50.639 ms (Muse) e 34.251 ms (Luna). A comparação usa tempo de parede.

Não houve chamada `final`, geração editorial nem revisão editorial nas duas rodadas novas. Muse retornou fontes YouTube sem transcrição; nenhuma citação ficou apta à revisão, portanto JEV não foi chamado. Luna localizou uma reportagem do Painel/Folha, mas a validação documental/JEV não confirmou a classificação proposta; as três afirmações terminaram sem comprovação. O baseline confirmou uma declaração pública, mas também não confirmou a alegação central. Isso comprova simplificação e limites preservados, **não melhoria da qualidade factual ou equivalência entre as conclusões**.

As três rodadas usaram ambiente local sem Blob e sem worker configurado; nenhuma leu áudio ou frames. Não é comparação direta com o histórico da implantação de produção. A pesquisa e as fontes podem variar entre execuções. Resultados completos, fases, diagnósticos e modelos efetivos estão em `tmp-dl/benchmark-estadao-comparison.json` e `tmp-dl/{baseline-luna,simplified-muse,simplified-luna}.json`.

Chromium exercitou o painel real em *Modelos & provedores*: três etapas — avaliação factual, visão e transcrição —, GPT-6 Luna selecionado em avaliação factual/visão e subtítulo sem a etapa de conclusão removida. Essa observação verifica a superfície de configuração, não o processamento de todas as modalidades.

Verificação integrada informada nesta atualização: **237 testes aprovados**, nenhum erro ou teste ignorado (**78,7 s**); build concluído; lint sem erros, com **6 avisos React**. Esses checks verificam contratos e integração de engenharia, não precisão factual.

## Smoke histórico de integração e paridade — `fact-check-7`, 14/10/2026

Comparação local do conteúdo de `https://x.com/gustavocagnotto/status/2110153143044440086`, com autorização para reutilizar a transcrição histórica de 1.900 caracteres do registro `mv7iwid7-cvossb`. A entrada textual foi mantida idêntica entre as repetições; pesquisa, obtenção de documentos, revisão e validação foram executadas novamente. O cache local foi invalidado antes de cada rodada. Não houve nova chamada à OpenAI, nova transcrição, extração do vídeo ou gravação dos resultados no Blob de produção.

Muse Spark `muse-spark-1.3-contributor` com revisão JEV `jev-1.13-free`:

| Execução local | Tempo | Afirmações | Com classificação sustentada | Sem comprovação | Resultado global |
| --- | ---: | ---: | ---: | ---: | --- |
| `mv7klcet-nzbe9o` | 38,5 s | 6 | 0 | 6 | `unproven`, sem nota |
| `mv7km64x-dcijq8` | 54,3 s | 7 | 1 | 6 | `unproven`, sem nota |
| `mv7knbzy-8fl9ly` | 48,2 s | 7 | 0 | 7 | `unproven`, sem nota |

Houve paridade do resultado agregado, não das afirmações e evidências. As buscas selecionaram fontes diferentes e a extração inicial variou; isso impede declarar estabilidade factual completa. JEV executou nas duas rodadas com trechos localizados; na primeira não havia trecho disponível para a revisão. A abstenção não confirma nem refuta os fatos do vídeo e não demonstra precisão do modelo.

DeepSeek `deepseek-v4.1-flash`, no mesmo replay, retornou duas falhas `model_bad_json` com texto vazio e uma execução concluída sem fontes elegíveis (`unproven`, sem nota). Não foi estabelecida paridade entre três resultados completos desse modelo.

Smoke adicional do adapter JEV com documentos reais das fontes do registro histórico: dois de três documentos obtidos, cinco de seis citações localizadas; uma de cinco afirmações manteve confirmação e quatro ficaram sem comprovação, sem nota agregada. A afirmação sobre Paulo Gustavo não manteve confirmação com documento indisponível.

Verificação de engenharia: suíte completa inicial com 179 testes aprovados; após os ajustes finais, 80 testes dos módulos afetados aprovados; build concluído. Lint sem erros, com quatro avisos de efeitos React em `Admin.jsx` e `ShareDialog.jsx`. A interface foi exercitada no navegador com fixture de nota nula, incluindo afirmações/fontes, prévia PNG e layout móvel sem overflow horizontal. O smoke direto de relações conflitantes retornou `unproven`, sem nota e com motivo explícito. Estes smokes não constituem benchmark humano nem comprovam implantação.

## Evidência de implementação de `fact-check-8`

A verificação de engenharia observada nesta atualização teve **230 testes aprovados** na suíte completa. Depois da integração final da interface, os **7 testes de `server/verify.test.js` passaram**, incluindo uma nova regressão que preserva os dois operandos quando as fontes apontam para a mesma URL, e o **build final concluiu**. O lint terminou sem erros, com seis avisos React: três de efeitos em `Admin.jsx`, um de efeito em `ShareDialog.jsx` e dois de pureza nas chamadas de relógio do handler de envio em `Verifier.jsx`.

Smoke controlado com HTTP e **JEV real**: documentos sintéticos documentaram A (2019 + 2020) = **200 ha** e B (2023 + 2024) = **20 ha**. O coletor obteve dois documentos e localizou quatro citações; a revisão agrupada retornou suporte e a validação final manteve `true`, nota 95. Ao remover o documento B, a comparação ficou `invalid` e inelegível. O caso exercita recuperação documental dos operandos, soma e revisão em conjunto; **não prova totais reais de queimadas, precisão factual geral ou implantação**. Não houve nova chamada real à OpenAI nesse smoke.

Smoke de recuperação com adapter HTTP local e cliente `verify` reais, usando resultado sintético já concluído em cache: o evento terminal foi deliberadamente descartado. Houve um POST, um GET legítimo de recuperação e um GET adicional de controle negativo com token errado (404), sem chamadas de inferência. O cliente marcou `recovered: true`; os IDs de aceitação, registro e resultado coincidiram, e o token não entrou no resultado normalizado/histórico. Esse caso controlado exercita entrega e autorização, não uma consulta factual real.

Smoke local da pergunta original sobre comparação de queimadas entre os períodos Lula/Bolsonaro, com `fact-check-8`, Muse e JEV: execução de **74,8 s**, resultado `unproven`, `score: null`, `comparison: null`. A pesquisa encontrou valores isolados de 2022, 2024 e 2025 para vegetação/floresta, não uma série florestal completa e comparável para 2019–2022 e 2023–2026. Dos três documentos selecionados, um foi obtido; uma de quatro citações foi localizada. Isso demonstra o caminho executado e seus limites, **não uma conclusão definitiva sobre os totais de queimadas nesses governos**, nem garantia de que toda pergunta comparativa produza conclusão numérica. Não houve nova chamada à OpenAI; Blob estava desabilitado e não houve escrita em produção.

## Evidência de implementação de `fact-check-9`

Smoke local com a imagem `media-tmp/card-versao-nova.png` e Muse Spark real: a etapa visual retornou `image: described`; a checagem preservou a alegação identificada como `unproven`. Geração e revisão editoriais concluíram e produziram um parágrafo em português distinguindo falta de comprovação de confirmação/refutação, sem declarar falha de leitura da imagem. Em uma execução anterior, a revisão editorial não concluiu e o resumo ficou vazio, com alegações preservadas. A saída final não contém contagens técnicas de localização de citações. Esses smokes demonstram os caminhos executados, não precisão factual geral nem implantação. O registro histórico `3b99efdf-739a-4ed9-85f8-b9f6ee4d6525` não estava acessível no ambiente local, sem token Blob configurado.

Verificação final: **229 testes aprovados**, build concluído e lint sem erros, com seis avisos React. Chromium exercitou componentes reais em 320, 375 e 390 px com dados controlados de textos/URLs/nomes longos, comparação, histórico/detalhe, upload, progresso, compartilhamento e painel administrativo: largura de rolagem igual à viewport nas superfícies verificadas. A autoria sem separadores reproduziu overflow antes da correção (2.688 px em viewport de 320 px). Resultados com resumo vazio não renderizaram `.result-summary`. Fixtures foram apenas do navegador, não respostas factuais reais.
