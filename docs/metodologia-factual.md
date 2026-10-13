# Metodologia factual

**Atualizada após implementação do plano.** Esta ferramenta automatiza a análise de afirmações; não substitui apuração, revisão profissional ou julgamento humano. Não há certificação ou afiliação ao IFCN declarada.

## Fluxo efetivo e versão

As novas checagens usam `fact-check-4`. O fluxo configura/cacheia a entrada, extrai mídia quando necessário, executa julgamento com busca web, valida evidências/pontuação e registra o resultado. Para imagens/vídeos, a etapa final recebe o material e um dossiê da primeira avaliação, com claims, fontes elegíveis, URLs estruturadas e consultas. Quando todos os claims da prévia têm classificação sustentada, a revisão não recebe ferramenta de busca; quando há claims sem comprovação, pode pesquisar lacunas e conflitos. Texto e links comuns usam o julgamento. Não são dois pesquisadores independentes.

A entrada do modelo é tratada como material não confiável: instruções embutidas em texto, páginas, OCR e transcrição não devem alterar a tarefa. Isso é uma instrução e uma salvaguarda de prompt, não uma prova de resistência a prompt injection.

A versão e a revisão da configuração integram o namespace do cache. Registros antigos não são reexecutados; quando não têm versão de metodologia, o painel os identifica como legados. Um registro preservado descreve aquela execução e não garante que uma execução atual repita a conclusão.

## Fontes e limites de evidência

Uma fonte só permanece quando sua URL HTTP(S) específica aparece em uma anotação `url_citation`, em `web_search_call.action.sources` ou em uma ação `open_page` concluída retornada pelo provedor, não é uma homepage genérica e está vinculada a uma afirmação. A requisição de busca solicita `include: ["web_search_call.action.sources"]`. A revisão final pode reutilizar a proveniência da primeira avaliação; URLs que aparecem apenas no JSON escrito pelo modelo não são aceitas. URLs inválidas, genéricas, sem proveniência ou sem vínculo são descartadas.

A evidência usa relação `supports`, `refutes` ou `context`, identificador de fonte e trecho. O servidor valida o vínculo estrutural, a relação e um trecho não vazio de pelo menos oito caracteres. **Não abre e confere independentemente a página para provar que o trecho existe ou sustenta a afirmação.** URL citada, título, relação e trecho podem continuar incorretos ou inadequados; a anotação de citação do provedor não é validação humana do conteúdo.

O registro preserva consultas, URLs estruturadas e diagnóstico por etapa: busca não solicitada, nenhuma chamada registrada, chamadas sem URLs rastreáveis ou proveniência disponível. Também preserva contagens de anotações/resultados e IDs/status/tipos/URLs tentadas das chamadas, não o envelope bruto completo ou todo conteúdo de páginas. Tentativa de abertura que falhou não qualifica uma URL como evidência. Uma URL retornada pela ferramenta demonstra proveniência, não pertinência semântica nem prova do trecho. A qualidade da busca e a seleção de fontes primárias ainda podem falhar.

### Comparação temporal

Os prompts distinguem publicação, coleta/referência, rodada anterior/atual, votos totais/válidos, percentuais/pontos percentuais e intenção de voto/rejeição. Datas relativas devem usar a data do material original, não automaticamente a data da checagem. Quando conhecidos, claims e evidências incluem `referencePeriod` com início/fim ISO. O servidor converte suporte/refutação de períodos disjuntos em contexto; sem outra evidência compatível, rebaixa a classificação e substitui a justificativa contraditória. Datas ausentes não são inventadas. Esse controle é estrutural: não valida independentemente as datas nem garante que intervalos sobrepostos sejam semanticamente comparáveis.


## Resultados, estados e pontuação

Estado operacional e veredito factual são campos distintos:

- `checked`: avaliação concluída com afirmações verificáveis.
- `partial_coverage`: o servidor limitou a lista a 50 afirmações e registrou quantas ficaram de fora.
- `insufficient_input`: material insuficiente para verificar.
- `inaccessible_media`: a mídia necessária não foi acessível ou processada.
- `no_verifiable_claims`: não foi identificada afirmação factual verificável.
- `error`: falha operacional registrada; não é um veredito.
- `legacy`: registro antigo sem contrato de resultado suficiente.

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

Uploads de imagem/vídeo enviam os bytes reais do arquivo. O servidor limita o arquivo a 3 MiB, confere assinatura e tipo antes de processar. Imagens usam o modelo de visão configurado. Vídeo/áudio requer um caminho de extração disponível; o worker pode extrair áudio e até 10 frames dos primeiros 300 segundos. A transcrição usa um modelo OpenAI elegível; frames/OCR usam o modelo de visão configurado. O worker não é uma dependência garantida em todo ambiente e não foi confirmado como implantado em produção nesta entrega.

A mídia pode falhar parcialmente: transcrição sem timestamps, áudio ausente, OCR/visão indisponível, link inacessível ou frames limitados. A resposta e o painel registram cobertura e tentativas quando disponíveis. Dez frames e uma transcrição não significam cobertura integral. Não há autenticação de autoria, data, montagem ou contexto de uma imagem/vídeo. Links de plataformas — inclusive X — dependem do extractor/worker e podem resultar apenas em metadados ou post; o sistema não garante download de todo vídeo.

Downloads de metadados, áudio e frames têm subetapas medidas. Depois da extração, transcrição e visão rodam em paralelo; falha de uma não descarta a outra. O painel mostra subetapas e fase principal: elas se sobrepõem e suas durações não devem ser somadas. Quantidade real de frames, timestamps fornecidos e duração retornada pelo worker são preservados, sem inventar timestamps ausentes.


## Avaliação reproduzível

O repositório inclui `scripts/evaluate-factual.mjs`, um harness que lê JSONL e calcula métricas por versão metodológica, configuração de modelo e modalidade. Nenhum corpus humano foi entregue nesta implementação; portanto, **não há resultados, taxa de precisão ou benchmark a publicar**. A recomendação inicial é reunir pelo menos 200 casos únicos, com cobertura por modalidade e categoria, antes de interpretar métricas como avaliação ampla.

Executar sobre corpus já anotado:

```sh
node scripts/evaluate-factual.mjs ./corpus-human.jsonl
```

Cada linha contém `caseId`, `runId` único, `groupId`, `methodologyVersion`, `modelConfiguration`, `modality`, duas `annotations` com `annotatorId`, `independent: true`, `verdict` e `claims` (listas), `adjudicated` e `prediction`. A adjudicação fornece `verdict`, `claims` (`id`, `verifiable`, `status`), `citations` (o `citationId` previsto e booleanos `relevant`, `relationCorrect`, `quoteSupported`) e `requiredCitations` (`claimId`, `url`). A previsão contém `verdict` (ou `null` para abstenção), claims com `claimId`/`status`, citações com `citationId`, `claimId`, `url`, `relation` e `quote`; `transcriptText` e `ocrText` são opcionais para medir WER.

O relatório inclui matriz de confusão, acurácia e macro-F1, falso positivo acusatório, precisão/recall de abstenção, precisão/recall e macro-F1 de claims, precisão de relevância/suporte de citação, acerto da relação, recall de citações necessárias, WER de transcrição/OCR, estabilidade entre execuções repetidas, concordância/Kappa dos vereditos dos anotadores e intervalos bootstrap de 95% agrupados por `caseId` (1.000 amostras determinísticas). Com menos de dois casos distintos, o intervalo não é calculado. `groupId` identifica casos relacionados e sua quantidade é reportada; o harness não detecta vazamento entre conjuntos nem cria divisão de treino/teste.

`independent: true` e a adjudicação são declarações no corpus: o script valida estrutura e consistência entre execuções, mas não autentica pessoas, independência real, qualidade das anotações, representatividade ou autenticidade das fontes. Atingir 200 casos só cumpre um limiar de volume, não torna o corpus um benchmark representativo. Os casos devem ser anotados por duas pessoas independentemente e adjudicados por uma pessoa competente; modelo de IA não serve como gabarito.

Consulte também [Correções](politica-correcoes.md), [Privacidade](privacidade-dados-ia.md) e o [plano e registro de implementação](admin-overview-plano.md) com o [status por fase](admin-status-implementacao.md).
