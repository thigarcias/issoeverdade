# Avaliação do corpus factual: anotação, adjudicação e separação dev/eval

Este documento descreve as ferramentas de corpus do repositório — `scripts/corpus-tool.mjs` (anotação dupla, acordo,
adjudicação e divisão dev/eval) e `scripts/evaluate-factual.mjs` (harness de métricas, gates e recortes) — e o protocolo
editorial que elas pressupõem. Toda a saída é em pt-BR e determinística: rodar duas vezes sobre o mesmo arquivo produz o
mesmo resultado, sem timestamps de relógio.

## Estado atual: nenhum corpus humano foi entregue

**Não há corpus humano anotado neste repositório e nenhum resultado de qualidade factual foi medido.** O que existe é o
arcabouço: harness, ferramenta de corpus e um fixture sintético. Consequências práticas:

- Não existem precisão, macro-F1, WER ou qualquer métrica publicável deste projeto. Nada pode ser anunciado como validado.
- `scripts/fixtures/corpus-sample.jsonl` é **sintético** (8 casos fictícios, sem pessoas ou fatos reais), serve apenas para
  exercitar as ferramentas em smoke tests e não tem valor estatístico.
- **Nenhuma métrica deve ser publicada isoladamente.** Todo número precisa vir com recorte (modalidade e categoria),
  `n`, intervalo de incerteza e o aviso de amostra insuficiente quando `n < 10`. Uma média global pode esconder falha
  em vídeo, em uma categoria ou em um tipo de alegação.
- As ferramentas validam estrutura, não pessoas: `independent: true` e a adjudicação são declarações do corpus. O script
  não autentica quem anotou, a independência real, a qualidade das decisões nem a autenticidade das fontes.

## Por que a bateria não cobriu os relatos de uso

A bateria de fontes e o corpus factual medem coisas diferentes. O relatório
[da bateria de 13/10](bateria-fontes-2026-10-13.md) registra 62 URLs e 8 uploads,
mas a maioria das sondas só lê, extrai ou valida conteúdo; não percorre a
checagem com IA até a interface e o PNG compartilhado. Esse relatório já
identificava que os testes de mídia não exercitavam o caminho `yt-dlp`.
Um download aprovado isoladamente não prova que a transcrição foi consumida,
nem que o resultado descreveu corretamente sua cobertura.

O harness factual lê `prediction` já registrada no JSONL; não baixa vídeos,
não chama a visão/transcrição, não mede latência de provedores e não renderiza
formulários ou cards. O smoke do fixture retorna 8 casos, apenas 2 por modalidade,
todos com aviso de amostra insuficiente. São dados sintéticos, não uma
validação das checagens reais nem dos dois IDs reportados.

Para liberar mudanças de mídia, a verificação precisa distinguir:

| Camada | Evidência necessária |
| --- | --- |
| Entrada | Texto digitável no celular; imagem com e sem contexto; contexto não reaproveitado de outra aba |
| Extração | Áudio real chega à transcrição; erro de download separado de erro de transcrição e ausência de fala |
| Cobertura | Metadados/OCR não apresentados como transcrição; contexto informado não tratado como prova |
| Resultado | Alegação, evidência e limite permanecem coerentes após a revisão |
| Compartilhamento | PNG legível, sem substituir síntese factual por mensagem interna de validação |
| Operação | Tempos por etapa e motivos de falha disponíveis no registro; reporte técnico chega à fila sem exigir fonte factual |

Regressões determinísticas cobrem essas transições quando reproduzíveis
localmente. Aprovação dessas regressões não atesta disponibilidade de uma
plataforma social, qualidade factual do modelo nem a causa de uma ocorrência
de produção sem seu registro original.


## Fluxo de trabalho

```sh
# 1. Começar do template (linhas "#" são comentários ignorados pelas duas ferramentas)
node scripts/corpus-tool.mjs init --out corpus-anotacao.jsonl

# 2. Validar schema, caseId único, enums e coerência de datas
node scripts/corpus-tool.mjs validate corpus-anotacao.jsonl

# 3. Medir acordo entre as duas anotações e listar divergências
node scripts/corpus-tool.mjs agreement corpus-anotacao.jsonl

# 4. Adjudicar: divergências exigem decisão humana registrada
node scripts/corpus-tool.mjs adjudicate corpus-anotacao.jsonl \
  --template-out decisoes.jsonl --out corpus-adjudicado.jsonl   # gera o esqueleto e falha sem as decisões
node scripts/corpus-tool.mjs adjudicate corpus-anotacao.jsonl \
  --decisions decisoes.jsonl --out corpus-adjudicado.jsonl
node scripts/corpus-tool.mjs validate corpus-adjudicado.jsonl --decisions decisoes.jsonl

# 5. Separar dev/eval por evento (reprodutível) e conferir vazamento
node scripts/corpus-tool.mjs split --eval-ratio 0.2 --out corpus-split.jsonl corpus-adjudicado.jsonl
node scripts/evaluate-factual.mjs --check-split corpus-split.jsonl

# 6. Avaliar
node scripts/evaluate-factual.mjs corpus-split.jsonl                          # resumo legível + relatório JSON
node scripts/evaluate-factual.mjs --json corpus-split.jsonl                   # só o relatório JSON
node scripts/evaluate-factual.mjs --require "verdict.macroF1>=0.85" corpus-eval.jsonl
```

Cada subcomando aceita `--help` (`node scripts/corpus-tool.mjs agreement --help`).

## Formato do registro (JSONL, uma linha por caso)

O harness já exigia `caseId`, `runId` único, `groupId`, `methodologyVersion`, `modelConfiguration`, `modality`,
`annotations` (exatamente duas, com `annotatorId`, `independent: true`, `verdict` e `claims`), `adjudicated` e
`prediction`. A extensão retrocompatível aceita novos campos, todos opcionais nos registros antigos:

| Campo | Tipo | Uso |
| --- | --- | --- |
| `split` | `"dev"` ou `"eval"` | separa desenvolvimento do conjunto reservado |
| `eventId` | texto | identifica o evento/assunto; base da divisão e do controle de vazamento |
| `category` | texto | recorte editorial (ex.: `saude`, `clima`, `economia`, `tecnologia`) |
| `annotatorA` / `annotatorB` | objeto ou `{annotatorId}` | liga explicitamente as duas anotações |
| `publishedAt`, `collectedAt`, `annotatedAt`, `adjudicatedAt` | data ISO 8601 | trilha de tempo, validada em ordem crescente |

`annotatorA`/`annotatorB` aceitam duas formas: objeto completo `{annotatorId, independent, verdict, claims}` (útil em
arquivos de anotação sem `annotations`) ou apenas `{annotatorId}`, referenciando o item correspondente de `annotations`.
Quando as duas formas aparecem no mesmo registro, elas precisam ser idênticas, senão o registro é recusado. `prediction`
continua sendo a saída do modelo: `verdict` (ou `null` para abstenção), claims com `claimId`/`status`, citações com
`citationId`, `claimId`, `url`, `relation` e `quote`; `transcriptText` e `ocrText` são opcionais (WER).

Linhas em branco e linhas iniciadas por `#` são ignoradas pelo harness e pelo corpus-tool. Um arquivo puramente JSONL
continua válido sem alteração.

## Guia de anotação

- **Quem anota.** Duas pessoas diferentes, cada uma com sua chave em `annotations`, marcadas com `independent: true`.
  Anotação de modelo não serve como gabarito nem como segunda anotação.
- **Independência.** As duas pessoas não discutem o caso antes de registrar o próprio veredito, não veem a saída do
  modelo (`prediction`) e não combinam rótulos. Discordância é informação legítima e vai para a adjudicação.
- **Veredito.** Um dos oito rótulos já usados pelo produto: `true`, `mostly_true`, `partially_true`, `distorted`,
  `unproven`, `misleading`, `false`, `no_verdict`. `no_verdict` é abstenção (material insuficiente/inacessível), não
  "provavelmente falso".
- **Claims atômicos.** Cada alegação verificável recebe um `id` estável no caso (`c1`, `c2`, …), com `verifiable: true` e
  `status` factual em `true`, `false`, `context` ou `unproven`. Opinião, previsão e juízo de valor entram como
  `verifiable: false` (o `status` não é usado nas métricas de status). Segmentar demais ou de menos muda precisão e
  revocação: mantenha o mesmo critério em todos os casos e registre a dúvida na nota da anotação.
- **Citações e fontes.** O gabarito registra, em `adjudicated.requiredCitations`, as referências exigidas para sustentar
  cada claim verificável e, em `adjudicated.citations`, o julgamento humano de cada citação prevista (`relevant`,
  `relationCorrect`, `quoteSupported`). Guarde links e documentos que sustentam o gabarito; ausência de trecho não é
  prova de falsidade.
- **Mídia.** Para vídeo/áudio, `transcriptText` é o texto de referência; para imagem, `ocrText`. Esses campos alimentam
  o WER e não substituem o julgamento do veredito.
- **Metadata editorial.** Preencha `eventId` (mesmo evento/assunto = mesmo id), `category`, `modality` e as datas.
  Casos do mesmo evento nunca podem ficar em splits diferentes.

## Dupla anotação e acordo

`node scripts/corpus-tool.mjs agreement <corpus.jsonl>` compara as duas anotações por caso e por campo:

| Campo | Comparação | Kappa de Cohen |
| --- | --- | --- |
| `verdict` | rótulo do caso | sim (nominal) |
| `claim.status` | status por claim presente nas duas anotações | sim (nominal) |
| `claim.verifiable` | booleano por claim compartilhado | sim (binário) |
| `claims` | conjunto de ids (também reporta o Jaccard médio) | sim (categórico pelo conjunto) |

O kappa só é calculado quando há pelo menos dois rótulos distintos e a concordância esperada é menor que 1; nesses casos
ele aparece como `n/d` com a coluna `aplicavel` = `nao`. Sozinho, o kappa é instável com amostra pequena — por isso a
ferramenta reporta também a concordância observada e o `n` de cada campo. O comando lista todas as divergências
(`caseId`, campo, chave do claim e os dois valores) e indica se o acordo de status factual por claim atinge a meta
proposta de 90%.

## Adjudicação

Divergência entre A e B não é resolvida por média nem por maioria automática: exige decisão humana registrada em um
arquivo JSONL de decisões, com autoria (`adjudicatorId`) e, se quiser, data e nota.

| Campo | Obrigatório | Valores |
| --- | --- | --- |
| `caseId` | sim | caso adjudicado |
| `field` | sim | `verdict`, `claims`, `claim.status` ou `claim.verifiable` |
| `key` | para campos de claim | `id` do claim |
| `decision` | sim | veredito válido; `include`/`exclude`; `true`/`false`; status factual |
| `adjudicatorId` | sim | quem decidiu (a adjudicação precisa ser atribuível) |
| `decidedAt`, `note` | não | data ISO 8601 e justificativa |

Regras aplicadas por `adjudicate`:

- Veredito igual nas duas anotações → adjudicação mecânica (o consenso é copiado). Se as anotações divergirem em
  veredito, a decisão de `field: "verdict"` é obrigatória.
- Claim presente em apenas uma anotação → decisão `include`/`exclude` obrigatória; claim presente nas duas entra sempre.
- Claim nas duas anotações com `verifiable` ou `status` diferentes → decisão do campo correspondente obrigatória.
- Claim presente em apenas uma anotação e incluído pelo adjudicador usa os valores de quem o registrou (só existe uma
  fonte), sem exigir decisão adicional.
- Decisões que não correspondem a nenhuma divergência são ignoradas com aviso; o comando **falha** listando as
  divergências sem decisão, e nunca decide sozinho. `--template-out` escreve o esqueleto a preencher.
- `adjudicated.citations` e `adjudicated.requiredCitations` já existentes são preservados; julgar citações é trabalho
  separado (depende da `prediction`) e o harness recusa corpus com citação prevista sem julgamento adjudicado.

O arquivo de decisões é o registro de auditoria da adjudicação: guarde-o junto do corpus versionado.

## Separação dev/eval e controle de vazamento

`node scripts/corpus-tool.mjs split <corpus.jsonl> --eval-ratio 0.2 [--out <corpus-split.jsonl>]` atribui o split **por
`eventId`**, com `sha256(sal + separador nulo + eventId)` → primeiros 4 bytes como inteiro / 2³² comparado a
`--eval-ratio`. Propriedades:

- **Reprodutível:** mesmo arquivo, mesmo sal (padrão `iev-split-v1`) e mesma razão → mesma divisão, em qualquer máquina.
  `--seed` muda a divisão inteira e deve ser evitado depois do congelamento.
- **Todos os casos do mesmo evento vão para o mesmo split**, o que é o que o plano exige (separação por evento/assunto).
- Sem `--out` nada é gravado: o comando só mostra a divisão calculada. O resumo informa eventos e execuções por split,
  a razão efetiva (a razão alvo é aproximada, porque o hash é por evento) e um aviso quando o conjunto `eval` tem menos
  de 10 eventos.
- `--eval-ratio` precisa ficar entre 0 e 1 (exclusive); `eventId` ausente em qualquer registro é erro, pois
  impossibilita a separação por evento.

`node scripts/evaluate-factual.mjs --check-split <corpus.jsonl>` falha (exit ≠ 0) se algum registro não tiver `split`
válido (`dev`/`eval`) ou `eventId`, ou se o mesmo `eventId` aparecer em `dev` e `eval`. Essa checagem cobre
**vazamento por evento, não vazamento de conteúdo**: sobreposição de assunto, fonte, recorte temporal ou paráfrase entre
casos diferentes continua sendo controle manual. O conjunto `eval` deve ser **congelado antes** de ajustar prompts,
rubrica ou seleção de fontes; depois disso, só entra caso novo com nova versão do corpus.

## Recortes, amostra insuficiente e gates

O harness imprime tabelas por **modalidade** e por **categoria** com `n`, casos únicos, cobertura de veredito
(`cob_veredito` = fração de execuções com veredito emitido), abstenção do modelo (`abstencao` = fração sem veredito),
abstenção do gabarito (`abst_gabarito`), acurácia e macro-F1. Recorte com `n < 10` é marcado como
`SIM (n < 10)` — amostra insuficiente — e o relatório traz um aviso explícito, além do campo `publicationWarning`, de
que nenhum número pode ser publicado isoladamente. O mesmo recorte também aparece no JSON (`byModality`, `byCategory`,
`splitCoverage`, `annotatorAgreement`, `globalMetrics`).

Gates propostos pelo plano de lançamento (metas a aprovar, **não resultados observados**) e como verificá-los:

| Gate proposto | Como verificar |
| --- | --- |
| Acordo de status factual por claim ≥ 90% | `corpus-tool agreement` (linha `claim.status`) ou `--require "annotators.claimStatusAgreement>=0.90"` |
| Macro-F1 ≥ 0,85 no conjunto reservado | avaliar um arquivo só com os registros `split: "eval"` e `--require "verdict.macroF1>=0.85"` |
| ≥ 95% das citações com trecho fiel e relação correta | `--require "citations.quoteSupportPrecision>=0.95"` e `--require "citations.relationAccuracy>=0.95"` |
| Nenhuma acusação falsa de alto impacto | `--require "verdict.falsePositiveAccusationRate<=0"` (denominador = casos não acusatórios no gabarito) |
| Cobertura e abstenção reportadas junto da precisão | colunas `cob_veredito`/`abstencao` das tabelas e `abstention.precision`, `abstention.recall` |
| Categoria sem amostra suficiente não pode ser anunciada como validada | aviso `amostra insuficiente (n < 10)` por modalidade e categoria |
| Nenhum resultado factual inventado em mídia inacessível / sem claim / entradas proibidas | não automatizado por estas ferramentas: revisão manual da bateria de liberação |

Chaves aceitas em `--require` (repetível; `chave>=valor`, com `<=`, `>`, `<`, `=`, `!=` também aceitos): `runs`,
`uniqueCases`, `verdict.accuracy`, `verdict.macroF1`, `verdict.falsePositiveAccusationRate`, `abstention.precision`,
`abstention.recall`, `claims.precision`, `claims.recall`, `claims.statusMacroF1`, `citations.relevancePrecision`,
`citations.relationAccuracy`, `citations.quoteSupportPrecision`, `citations.requiredRecall`, `media.transcriptWer`,
`media.ocrWer`, `stability.agreement`, `annotators.verdictAgreement`, `annotators.verdictKappa`,
`annotators.claimStatusAgreement`. WER e taxa de acusação falsa são "menor é melhor" (use `<=`); as demais são "maior é
melhor". Métrica indisponível (sem caso aplicável ou amostra insuficiente) **falha** o gate em vez de ser ignorada, e
uma chave inexistente encerra com a lista de chaves válidas. O comando sai com código ≠ 0 quando algum gate falha, e o
relatório JSON traz `requirements`, `requirementsMet` e o observado de cada gate com seu `n` implícito no relatório.
Lembrete: `--require` avalia **todos** os registros do arquivo recebido — para gate sobre o conjunto reservado, aponte o
comando para um arquivo com apenas os casos `eval`.

## Fixture sintético e smoke test

`scripts/fixtures/corpus-sample.jsonl` tem 8 casos fictícios: `text`, `link`, `image` e `video`; 4 em `dev` e 4 em
`eval`; adjudicação mecânica em 6 casos e decisão humana registrada em 2 (`caso-002`, veredito; `caso-007`, status de
claim), com as decisões em `scripts/fixtures/adjudication-decisions.jsonl`. Dois casos usam
`annotatorA`/`annotatorB` completos e os outros usam a forma de referência. O fixture também exercita citações
avaliadas, citação exigida não recuperada, abstenção do modelo, abstenção correta, acusação falsa e WER de transcrição e
de OCR.

```sh
node scripts/corpus-tool.mjs validate scripts/fixtures/corpus-sample.jsonl
node scripts/corpus-tool.mjs agreement scripts/fixtures/corpus-sample.jsonl
node scripts/corpus-tool.mjs adjudicate scripts/fixtures/corpus-sample.jsonl \
  --decisions scripts/fixtures/adjudication-decisions.jsonl --out /tmp/adjudicado.jsonl
node scripts/corpus-tool.mjs split --eval-ratio 0.5 scripts/fixtures/corpus-sample.jsonl
node scripts/evaluate-factual.mjs --check-split scripts/fixtures/corpus-sample.jsonl
node scripts/evaluate-factual.mjs scripts/fixtures/corpus-sample.jsonl
```

Todos os recortes do fixture têm `n = 2`: as saídas são esperadamente marcadas como amostra insuficiente. O fixture não
é corpus de avaliação, não deve ser usado para aprovar gate e não substitui os 200 casos únicos recomendados.

## Limitações conhecidas

- O harness não confere autenticidade, independência real dos anotadores nem qualidade da adjudicação; verifica
  estrutura e coerência entre execuções.
- `--check-split` cobre vazamento por `eventId`; vazamento de conteúdo é manual.
- Recortes com `n < 10` são avisados, não impedidos: a decisão de ampliar amostra ou aprovar escopo menor é editorial.
- `--require` avalia o arquivo inteiro; recortes por modalidade/categoria exigem arquivos ou execuções separadas.
- Kappa pode ser `n/d` (poucos rótulos distintos) e é instável em amostra pequena; a concordância observada é reportada
  junto. O harness valida estrutura de anotação de corpus com `annotations`; arquivos de anotação apenas com
  `annotatorA`/`annotatorB` são aceitos pelo corpus-tool, mas precisam de `annotations` para o harness.

Consulte também [Metodologia factual](metodologia-factual.md), [Política de correções](politica-correcoes.md) e o
[plano de lançamento](plano-lancamento-producao.md).
