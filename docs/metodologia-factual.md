# Metodologia factual

**Atualizada após implementação do plano.** Esta ferramenta automatiza a análise de afirmações; não substitui apuração, revisão profissional ou julgamento humano. Não há certificação ou afiliação ao IFCN declarada.

## Fluxo efetivo e versão

As novas checagens usam `fact-check-5`. O fluxo configura/cacheia a entrada, aplica triagem de propósito e moderação, extrai mídia quando necessário, executa julgamento com busca web, revisa com dossiê, **obtém os documentos das fontes vinculadas para localizar os trechos citados** e valida evidências/pontuação antes de fixar score/veredito. Para imagens/vídeos, a etapa final recebe o material e um dossiê da primeira avaliação, com claims, fontes elegíveis, URLs estruturadas e consultas. Quando todos os claims da prévia têm classificação sustentada, a revisão não recebe ferramenta de busca; quando há claims sem comprovação, pode pesquisar lacunas e conflitos. Texto e links comuns usam o julgamento. Não são dois pesquisadores independentes.

Ordem das etapas de segurança: (1) política de URL no endpoint; (2) triagem de propósito (pedido direto ao assistente não é afirmação verificável); (3) moderação de texto/imagem antes das chamadas caras; (4) cobertura de vídeo declarada; (5) moderação da transcrição e dos frames amostrados antes da visão; (6) análise factual; (7) dossiê de evidências; (8) validação e registro.

A entrada do modelo é tratada como material não confiável: instruções embutidas em texto, páginas, OCR e transcrição não devem alterar a tarefa. Isso é uma instrução e uma salvaguarda de prompt, não uma prova de resistência a prompt injection.

A versão e a revisão da configuração integram o namespace do cache, junto da época de invalidação (`iev-cache-v2/epoch.json`): uma correção editorial invalidada pelo painel deixa de servir resultados antigos como versão vigente. Registros antigos não são reexecutados; quando não têm versão de metodologia, o painel os identifica como legados. Um registro preservado descreve aquela execução e não garante que uma execução atual repita a conclusão.

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
extração `article-content-v3` integra o cache sem alterar as regras
`fact-check-5` para perguntas e alegações futuras.

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



### Perguntas, rumores e ações futuras

`fact-check-5` orienta julgamento e revisão a investigar hipóteses factuais implícitas em perguntas, inclusive informais. Uma pergunta sobre uma ação futura atribuída a alguém deve levar à busca de declarações, anúncios, propostas ou medidas verificáveis, não à previsão do futuro nem à classificação automática como `no_verifiable_claims`.

O claim deve explicitar a hipótese investigada, sem inventar uma fala ou alvo. Um caso individual não identificado fica em `notCheckedClaims`; isso não impede investigar a alegação geral. Desmentidos antigos são contexto, não refutação automática de uma hipótese atual. Sem evidência adequada, o claim fica `unproven`. Opiniões e previsões puras continuam sem pontuação factual; os controles de segurança não foram relaxados.

Smoke real da pergunta “o lula vai fechar a minha igreja???”: `checked`, claim geral `unproven`, pesquisa sobre declarações/medidas e caso individual registrado como não checado. O desmentido de 2022 foi usado como contexto. Esta execução confirma o caminho exercitado, não garante respostas idênticas em todas as execuções do modelo.


## Fontes e limites de evidência

Uma fonte só permanece quando sua URL HTTP(S) específica aparece em uma anotação `url_citation`, em `web_search_call.action.sources` ou em uma ação `open_page` concluída retornada pelo provedor, não é uma homepage genérica e está vinculada a uma afirmação. A requisição de busca solicita `include: ["web_search_call.action.sources"]`. A revisão final pode reutilizar a proveniência da primeira avaliação; URLs que aparecem apenas no JSON escrito pelo modelo não são aceitas. URLs inválidas, genéricas, sem proveniência ou sem vínculo são descartadas.

A evidência usa relação `supports`, `refutes` ou `context`, identificador de fonte e trecho. O servidor valida o vínculo estrutural, a relação e um trecho não vazio de pelo menos oito caracteres. Depois da revisão final, ele **obtém o documento da fonte** (até `IEV_EVIDENCE_MAX_DOCS` por checagem, com teto de bytes por documento e por job), extrai texto de HTML ou PDF e **localiza o trecho citado** por comparação literal, normalizada (sem acentos/caixa) ou aproximada (mesmos tokens com pontuação diferente). O resultado de cada citação é registrado como `exact`, `normalized`, `approximate`, `prefix`, `tokens`, `missing`, `empty_quote`, `document_unavailable` ou `not_fetched`.

Quando há trecho localizado, uma revisão adicional por modelo decide se o trecho sustenta, refuta, contextualiza, é inconclusivo ou **contradiz** a relação afirmada. Se um claim confirmado/refutado não tem nenhuma citação confirmada e não há contradição, ele volta para `unproven` com justificativa própria; se há contradição, a justificativa afirma que o documento diz algo diferente do citado.

**Isso não prova que a fonte esteja errada nem que a citação seja fiel ao contexto integral.** Ausência de trecho é limitação registrada, nunca falsidade: paywall, página que exige JavaScript, PDF sem texto extraível, tradução e paráfrase aparecem como `document_unavailable`/`missing`. A revisão por modelo é defesa adicional, não validação humana, e não substitui o corpus humano anotado.

O registro preserva consultas, URLs estruturadas e diagnóstico por etapa: busca não solicitada, nenhuma chamada registrada, chamadas sem URLs rastreáveis ou proveniência disponível. Também preserva contagens de anotações/resultados e IDs/status/tipos/URLs tentadas das chamadas, não o envelope bruto completo ou todo conteúdo de páginas. Tentativa de abertura que falhou não qualifica uma URL como evidência. Uma URL retornada pela ferramenta demonstra proveniência, não pertinência semântica nem prova do trecho. A qualidade da busca e a seleção de fontes primárias ainda podem falhar.

### Comparação temporal

Os prompts distinguem publicação, coleta/referência, rodada anterior/atual, votos totais/válidos, percentuais/pontos percentuais e intenção de voto/rejeição. Datas relativas devem usar a data do material original, não automaticamente a data da checagem. Quando conhecidos, claims e evidências incluem `referencePeriod` com início/fim ISO. O servidor converte suporte/refutação de períodos disjuntos em contexto; sem outra evidência compatível, rebaixa a classificação e substitui a justificativa contraditória. Datas ausentes não são inventadas. Esse controle é estrutural: não valida independentemente as datas nem garante que intervalos sobrepostos sejam semanticamente comparáveis.


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

O servidor limita as notas dos claims a âncoras fixas: `true` 85/90/95, `context` 55/70, `unproven` 35/45 e `false` 5/20. O score geral é a média aritmética arredondada dos claims verificáveis; um claim `false` com nota 5 limita o score geral a 64. As faixas atuais são:

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

Uploads de imagem/vídeo enviam os bytes reais do arquivo. O servidor limita o arquivo ao teto configurado (padrão 3 MiB), confere assinatura e tipo antes de processar e recusa texto acima de `IEV_MAX_TEXT_CHARS` em vez de truncar. Imagens usam o modelo de visão configurado. Vídeo/áudio requer um caminho de extração disponível; o worker pode extrair áudio e até 10 frames ao longo do vídeo, respeitando `IEV_MAX_MEDIA_SECONDS` (padrão 900 s) — acima disso a mídia não é processada. Downloads remotos têm teto de bytes por resposta, por arquivo e por job, com vigia de disco que interrompe a árvore de processos do `yt-dlp`/`ffmpeg`. A transcrição usa um modelo OpenAI elegível; frames/OCR usam o modelo de visão configurado. O worker não é uma dependência garantida em todo ambiente e não foi confirmado como implantado em produção nesta entrega.

A mídia pode falhar parcialmente: transcrição sem timestamps, áudio ausente, OCR/visão indisponível, link inacessível ou frames limitados. A resposta e o painel registram cobertura e tentativas quando disponíveis. Dez frames e uma transcrição não significam cobertura integral. Não há autenticação de autoria, data, montagem ou contexto de uma imagem/vídeo. Links de plataformas — inclusive X — dependem do extractor/worker e podem resultar apenas em metadados ou post; o sistema não garante download de todo vídeo.

Downloads de metadados, áudio e frames têm subetapas medidas. Depois da extração, transcrição e visão rodam em paralelo; falha de uma não descarta a outra. O painel mostra subetapas e fase principal: elas se sobrepõem e suas durações não devem ser somadas. Quantidade real de frames, timestamps fornecidos e duração retornada pelo worker são preservados, sem inventar timestamps ausentes.


O card compartilhável inclui o **ID da checagem**, a indicação de que a análise é automatizada (e que a nota não é probabilidade calibrada) e o endereço para conferir correções daquele resultado. Cards já baixados não podem ser recolhidos ou atualizados automaticamente: o link é o que permite verificar a versão vigente.

## Avaliação reproduzível

O repositório inclui `scripts/evaluate-factual.mjs`, um harness que lê JSONL e calcula métricas por versão metodológica, configuração de modelo e modalidade. Nenhum corpus humano foi entregue nesta implementação; portanto, **não há resultados, taxa de precisão ou benchmark a publicar**. A recomendação inicial é reunir pelo menos 200 casos únicos, com cobertura por modalidade e categoria, antes de interpretar métricas como avaliação ampla.

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
