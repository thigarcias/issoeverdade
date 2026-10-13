# Admin: diagnóstico visual, catálogo de IA e metodologia factual

## 1. Escopo e conclusão

Esta entrega começou como auditoria e plano de implementação. O plano foi executado nas superfícies de código citadas; o **status por fase e as evidências** estão na seção 9. As afirmações da auditoria abaixo descrevem o estado observado **antes** da execução.

**Conclusão:** o admin mistura monitoramento, investigação e configuração numa única coluna. A configuração de IA ocupa o espaço principal antes da lista de checagens. Além da organização visual, há problemas de contrato: modelos incompatíveis são oferecidos, a seleção de transcritor não corresponde à requisição efetiva e o validador admite resultados incoerentes. Corrigir esses contratos antes de simplesmente acrescentar opções ou trocar o modelo.

Evidências utilizadas:

- Inspeção de código do frontend, APIs e pipeline server-side.
- Navegação autenticada no painel de produção, desktop e viewport de 390 px; abertura de detalhes e abas, sem salvar configuração nem iniciar novas checagens.
- Consulta ao catálogo público Go e ao catálogo autenticado OpenAI da conta disponível no ambiente local. Nenhuma credencial foi incorporada a este documento.
- Smoke executado com entradas sintéticas diretamente em `validateResult`. Isso demonstra inconsistências do contrato, **não mede a precisão factual dos modelos**.
- Referências primárias dos provedores e princípios IFCN. Não constitui certificação IFCN.

Registros antigos são evidência do comportamento registrado naquela execução, não prova de que a versão atual reproduzirá o mesmo resultado.

## 2. Overview do painel atual

### Organização existente

`src/components/Admin.jsx:687-862` renderiza, nesta ordem: cabeçalho → indicadores → configuração de IA → busca/ordenação → filtros → lista paginada → diálogo de detalhe. O diálogo tem Resumo, Afirmações, Fontes, Mídia e Prompts & IA (`:113-119`).

| Problema | Evidência | Mudança proposta |
| --- | --- | --- |
| Operação e configuração competem pela mesma tela | O card de IA vem antes da busca/lista (`Admin.jsx:724-735`); no desktop observado a lista fica abaixo da primeira dobra | Separar Checagens, Modelos & provedores e Metodologia em navegação administrativa |
| Linguagem visual de landing page, não de ferramenta operacional | Header público permanece no admin (`src/App.jsx:74-79`); largura máxima de 900 px (`src/index.css:804-807`) | Shell administrativo próprio, preservando creme/tinta/acento e identidade da marca |
| Lista dificulta comparação transversal | Cada item é um botão-card com texto, ID, tempo e modelo (`Admin.jsx:814-834`) | Tabela compacta no desktop; cards estruturados no celular |
| Indicadores não explicitam universo | Estatísticas calculadas sobre `items` carregados (`Admin.jsx:615-627`), não uma agregação global | Exibir período, quantidade de registros disponíveis e limites de retenção; não chamar amostra de total histórico |
| Atualização pouco clara | Botão Atualizar recarrega lista; IA é carregada separadamente (`Admin.jsx:494-532,692`) | Última atualização visível e ações específicas por seção |
| Falha de configuração some da interface | `loadAi` captura erro e oculta card (`Admin.jsx:529-531`) | Estado de erro com motivo seguro e ação de tentar novamente; não parecer recurso inexistente |
| Overflow horizontal em celular | Viewport 390 px, `scrollWidth=410`; elementos excedentes são `.admin-row`/metadados | Corrigir min-width e quebra de conteúdo; garantir zero rolagem horizontal da página |
| Detalhe exige rolagem longa e mistura diagnóstico com resultado | Configuração técnica e correções junto ao resumo; tabs quebram em duas linhas no celular | Resumo editorial separado de execução técnica; navegação de detalhe acessível e contextual |
| Scores de registros novos ausentes | Registro recente sem nota na UI, enquanto antigos mostram nota; `server/checklog.js:27-54` omite `score` embora índice use `record.score` | Restaurar contrato de serialização; diferenciar nota ausente de nota zero |
| Risco de diálogo reabrir após fechamento durante carregamento | Observado fechamento do skeleton seguido de reaparecimento ao chegar resposta; `openDetail` não invalida requisição (`Admin.jsx:572-583`) | Ignorar respostas obsoletas ao fechar/trocar registro; cenário de aceite específico |

Não foi feita medição instrumental de contraste nem auditoria completa WCAG; não afirmar que a interface passa ou falha integralmente nesses critérios.

### Arquitetura de informação proposta

1. **Visão geral:** indicadores com período, saúde operacional e últimos registros. Métricas adicionais só quando houver dados reais, nunca números estimados apresentados como observados.
2. **Checagens:** tela principal de trabalho, busca por ID/texto, filtros combináveis e inspeção de evidências.
3. **Modelos & provedores:** inventário completo, configuração por etapa, compatibilidade, origem da configuração e política de fallback.
4. **Metodologia:** versões publicadas de prompts/rubrica, significado dos status e resultados de avaliações. Não liberar edição arbitrária de prompt em produção como parte implícita desta reorganização.

No desktop, navegação lateral compacta e área útil de aproximadamente 1200–1440 px. No celular, navegação compacta no topo, sem sidebar fixa. Evitar cards decorativos para cada campo e excesso de bordas aninhadas.

### Tela Checagens

- Toolbar: busca, período quando suportado pelo backend, tipo de entrada, status operacional e veredito factual separados.
- Tabela: conteúdo resumido, resultado factual, estado da execução, origem/tipo, data, duração e modelo efetivo. ID copiável no detalhe.
- Densidade consistente; cabeçalho legível; truncamento somente com acesso ao texto integral.
- Paginação mantém filtros e posição. Estado vazio distingue ausência de registros, filtro sem resultado e erro de carregamento.
- Indicadores de resultados antigos, cache, cobertura parcial e fontes inacessíveis dependem de contratos reais descritos abaixo.

### Detalhe da checagem

Preferir página de detalhe com URL compartilhável dentro da sessão administrativa e botão de voltar que preserve busca/página. Se mantido diálogo, implementar tratamento explícito de requisição obsoleta e foco.

Seções:

- **Resultado:** afirmação-alvo, conclusão, limites e data de corte.
- **Afirmações & evidências:** cada claim com prova de suporte/refutação/contexto, trecho literal, URL e data; não apenas uma lista solta de links.
- **Mídia:** original, áudio/transcrição, frames com timestamps, intervalos cobertos e falhas de acesso.
- **Execução:** fases, solicitado versus efetivamente usado, fallback, cache e correções.
- **Prompts:** versão/hash do sistema, entrada analisada e resposta; previews marcados como truncados.

### Direção visual

- Preservar identidade creme, tinta escura e vermelho; priorizar superfícies, divisores e espaçamento em vez de sombras repetidas.
- Tipografia sans para dados/controles; serifada restrita a títulos de marca/seção. Números tabulares para duração e nota.
- Escala de espaçamento de 4/8/12/16/24/32 px; controles com área de toque adequada e foco visível.
- Cor não é o único sinal: status sempre tem rótulo e ícone quando útil.
- Separar erro operacional de falsidade factual na cor e no texto.
- Todos os estados: carregando, vazio, falhou, sem permissão, indisponível, rascunho e salvo.

A rota literal `https://issoeverdade.vercel.app/admin` respondeu **404** nesta inspeção; a rota funcional é `https://issoeverdade.vercel.app/#/admin` (`src/App.jsx:65-71`). Decidir e documentar uma URL canônica; se adotar `/admin`, incluir roteamento/deep-link de produção, não apenas alterar links.

## 3. Seletor: por que faltam modelos

**Causa confirmada:** `server/ai-config.js:8-28` mantém uma lista manual com um modelo Go e quatro OpenAI. `api/admin.js:22-24` publica essa lista; `Admin.jsx:408-440` só a renderiza. Não há descoberta dos modelos disponíveis.

| Provedor | Catálogo atual no código | Evidência externa consultada |
| --- | --- | --- |
| OpenCode Go | Muse Spark 1.3 Contributor | Endpoint público retornou 39 IDs nesta consulta |
| OpenAI | Luna 6, Whisper 1, GPT-4o Transcribe e Mini Transcribe | `GET /v1/models` autenticado retornou HTTP 200 e 139 IDs na conta local |

Os inventários incluem modelos que **não servem** para julgamento, visão ou transcrição. Aparecer no inventário não confirma capacidade, acesso de inferência, disponibilidade na conta de produção ou adequação metodológica.

Exemplos ausentes encontrados: Go inclui Grok, GLM, DeepSeek, Kimi, Qwen, MiniMax, MiMo e outros; OpenAI inclui GPT-6 Astra/Sol/6.1 Sol, GPT-5.6 Sol/Terra/Luna, GPT-4.1/4o, outros GPT-5 e famílias de áudio/imagem/embedding. Não copiar uma lista estática desta auditoria como solução permanente.

### Defeitos que precisam vir antes da expansão

| Prioridade | Defeito | Referência |
| --- | --- | --- |
| P0 | Modelo recebido por transcrição não é enviado: multipart usa constante `MODEL`, mas retorno informa parâmetro `model` | `server/transcribe.js:39-49,79,109` |
| P0 | Provedor selecionado para transcrição é ignorado; execução usa endpoint/chave OpenAI | `server/verify.js:331`; `server/transcribe.js:10,20-21,82-85` |
| P0 | Todos os modelos aparecem em todas as etapas; é possível escolher transcritor para julgamento ou modelo de texto para áudio | `server/ai-config.js:56-76`; `Admin.jsx:405-440` |
| P1 | Trocar provedor escolhe primeiro modelo, não primeiro compatível com a etapa | `Admin.jsx:420-422` |
| P1 | IDs OpenAI arbitrários passam por regex, enquanto Go fora da lista é rejeitado; entrada inválida vira fábrica silenciosamente | `server/ai-config.js:62-76` |
| P1 | Cache de 24h não inclui modelo/configuração/metodologia | `server/cache.js:8,16-18`; `verify.js:409-442` |
| P1 | Memória muda antes de persistir; falha pode aplicar config apesar do erro. Sem Blob, config é perdida após TTL de 60s | `server/ai-config.js:89-102,130-140` |
| P1 | “Salvo no servidor” é inferido da existência do token, não de leitura/gravação confirmada | `api/admin.js:30`; `ai-config.js:114-126` |
| P1 | Fallback Luna é fixo e não representa necessariamente a escolha do admin | `server/verify.js:142-156,299-304,491-505` |

Transcritores têm formatos de retorno diferentes; `verbose_json`/timestamps não são universais. `transcriptToPrompt` também precisa consumir texto válido sem segmentos (`server/transcribe.js:119-121`).

### Plano de catálogo completo e seguro

1. Descobrir IDs server-side: OpenAI com chave da conta, Go pelo endpoint do produto correto. Separar Go de Console/Zen pay-as-you-go.
2. Manter inventário com ID exato, produto, protocolo, modalidades, ferramentas, formatos, timestamps, disponibilidade e fonte/data dos metadados.
3. Enriquecer descoberta com capacidades documentadas. “Desconhecido” é estado explícito, não autorização para selecionar.
4. Implementar adapters reais para Responses, Chat Completions, Messages e transcrição conforme os modelos habilitados. O pipeline atual usa Responses: muitos modelos Go exigem outro protocolo.
5. Mostrar todo o inventário pesquisável, inclusive incompatíveis com motivo; seletor por etapa oferece apenas opções elegíveis. Para julgamento/final, exigir busca/evidência real, nativa ou por fluxo externo implementado.
6. Validar combinações no servidor; POST incompatível deve retornar erro de campo sem modificar estado. Não substituir pela fábrica silenciosamente.
7. Versionar configuração; informar origem (`blob`, `env`, `factory`, `ephemeral`), revisão, atualização e persistência real. Aplicar memória após sucesso durável.
8. Registrar solicitado/usado/fallback/não executado por fase; incluir revisão de configuração e metodologia na identidade do cache.
9. Se descoberta falhar, manter último inventário válido com alerta de desatualização. Não esvaziar seletor nem inventar disponibilidade.

A documentação Go atual publica `/inference/go/v1/...`, enquanto o código usa `/zen/go/v1/responses`. A navegação desta auditoria não demonstrou que a rota antiga esteja quebrada; validar alias/suporte antes de migrar.

**Risco de produto/privacidade:** Go é documentado para tráfego de coding agents; confirmar adequação comercial do uso factual. Muse Contributor tem condições de treinamento/retenção/região próprias, que devem ser avaliadas antes de escolhê-lo como padrão. Não pressupor privacidade igual entre modelos.

## 4. Validação dos prompts e da metodologia

### Fluxo atual

Configuração/cache → metadados → judge → enriquecimento condicional com áudio/visão → final → filtro de URLs/vínculos → validador de score → log/cache.

Não há hoje uma separação formal entre pesquisador de evidências e juiz independente. Judge e final fazem pesquisa e conclusão; visão descreve frames; transcrição usa serviço de áudio. Acrescentar “agentes” sem contratos verificáveis não resolve qualidade.

Pontos positivos: busca web solicitada, proibição de inventar URLs/homepages, vínculo por claim, pedido de mídia no judge, correções e fases registradas. Essas proteções são úteis, mas insuficientes para garantir correspondência entre prova e conclusão.

### Achados dos prompts

| Prioridade | Achado | Plano |
| --- | --- | --- |
| P0 | `RESULT_SHAPE` é pseudo-JSON inválido, embora chamado de formato exato (`scoring.js:36`) | Schema estruturado válido com enums e relações; explicações fora do exemplo JSON |
| P0 | Dados de página/post são apresentados como algo em que confiar; fronteira contra instruções em mídia não é explícita (`verify.js:27,34,528`) | Material extraído é conteúdo não confiável; nunca altera regras, ferramentas ou conclusão |
| P0 | Final não possui abstensão equivalente ao judge (`scoring.js:39-52`) | Permitir saída de insuficiência/inacessibilidade em qualquer etapa |
| P1 | Exigência inicial de três fontes conflita com permissão posterior de menos fontes e incentiva enchimento (`scoring.js:34`) | Melhor evidência disponível por claim; sem quota artificial ou proibição de vários documentos do mesmo órgão |
| P1 | `true` exige oficial ou dois veículos, mas permite score para um veículo (`scoring.js:12,19`) | Definir política única de suficiência, independência e força da evidência |
| P1 | Fontes são descritas como “confirmam”, inclusive para claims falsos (`scoring.js:16,34,36`) | Relação explícita `supports`, `refutes`, `provides_context` |
| P1 | Especialização fixa em segundo turno 2026 não substitui data da afirmação/análise | Data de corte e contexto temporal explícitos; distinguir fato ocorrido, previsão e alegação |
| P1 | Visão mistura descrição com possível inferência, sem timestamp/legibilidade (`verify.js:275-297`) | OCR literal separado de observações e inferências; registrar localização temporal e limitações |

Prompt injection é risco identificado por inspeção, não exploração demonstrada nesta rodada.

### Problemas metodológicos estruturais

- **URL acessível não é prova:** `sanitizeSources` verifica profundidade/HTTP, não conteúdo probatório (`verify.js:169-238`). Preservar documentos/trechos/citações e verificar relação com a afirmação literal, data, entidade e número.
- **Busca oferecida não é busca comprovada:** resposta extrai texto e não preserva toda proveniência da ferramenta (`verify.js:44-54,94-120`). Registrar consultas, resultados e citações usados.
- **Inacessível não é falso:** fallback sem claims com score 30 (`verify.js:544-553`) é classificado como enganoso pelo validador. Separar estado operacional de veredito factual.
- **Metadados não são conteúdo integral:** `transcript || mediaContext` pode levar ao final com título/descrição (`verify.js:526-536`). Exigir conteúdo/cobertura adequados ou limitar explicitamente a conclusão à legenda acessível.
- **Áudio e vídeo são complementares:** OCR só roda quando fala reconhecida tem menos de 12 caracteres (`verify.js:340-341`). Vídeo narrado pode ter alegação diferente na tela. Dez frames e primeiros ~300 segundos não garantem cobertura integral (`media.js:181-182,239-259`).
- **Uploads não entregam bytes:** frontend/API enviam nome de arquivo, não material para análise (`src/components/Verifier.jsx:129`; `src/lib/api.js:112-115`; `api/verify.js:62-71`). Implementar contrato real ou deixar limitação inequívoca; nome não comprova conteúdo.
- **Opinião/condicional não é factualidade intermediária:** extrair somente unidades verificáveis; preservar conteúdos não verificáveis fora da média. Score não é probabilidade calibrada.
- **Segmentação altera média:** média simples é sensível à decomposição e pode diluir claim central falso. Formalizar política editorial antes de substituir fórmula por pesos arbitrários.
- **Filtros descartam documentos necessários:** deduplicação por outlet, limite de fontes e falha HEAD/HTTP podem eliminar provas distintas ou legítimas (`verify.js:174-234`). Separar documento, independência editorial e estado de acesso.
- **Cobertura silenciosamente limitada:** `claims.slice(0,10)` elimina claims adicionais (`scoring.js:90`). Preservar cobertura parcial explicitamente.
- **Rastreabilidade incompleta:** log omite score/cache de origem, não guarda versão completa do prompt de sistema e trunca previews (`checklog.js:27-54`; `verify.js:599-602`).
- **Cache e privacidade:** cache ignora versões e grava retorno em Blob público (`cache.js:16-18,55-59`). Revisar classificação/retenção e migrar dados de análise para armazenamento privado. Não foi demonstrada enumeração/exposição pública nesta auditoria.

### Smoke do validador: resultados observados

Executado diretamente com Node, importando `server/scoring.js`, sem chamada a LLM:

| Cenário sintético | Resultado atual observado | Invariante proposto |
| --- | --- | --- |
| Sem claims, score 99 | Verdadeiro, 99 | Sem afirmação verificável não recebe selo verdadeiro |
| Claim false com score 95 | Verdadeiro, 95 | Status e score devem ser compatíveis |
| Claim true sem propriedade sources | Verdadeiro, 95 | Ausência de prova não é contornável omitindo campo |
| Dois claims context=73, geral 75 | Maioria verdadeira, 75 | Média exata, sem tolerância atravessando faixa |
| Nove true=95 e um false=5 | Distorcido, 86 | Nota e selo não apresentam conclusões contraditórias |
| Parsing de RESULT_SHAPE | Erro de JSON | Exemplo/contrato de saída válido |

Referências: `scoring.js:85-140`. Não significa que os modelos sempre emitam esses casos; significa que o servidor os aceita. Corrigir também resumo/notas quando correções mudarem conclusão: hoje o validador muda nota/selo sem reconciliar o texto.

### Revisão dos casos reportados

| Checagem | Evidência consultada | Interpretação e ação |
| --- | --- | --- |
| `mv6ppkgz-06zfy` | Fontes preservadas: youtube.com, expatsba.com, particle.news | Homepages continuam no histórico. Marcar versão antiga e definir rechecagem explícita; não dizer que filtro atual foi testado e falhou |
| `mv6q7j1a-x7yju` | Fontes: teaser Casa Verde e Amarela, notícia relator TSE, Wikipedia Mais Médicos; resumo sobre moradia/Bolsa Família/remédios | Suspeita fundamentada de vínculos inadequados. Títulos não bastam para julgar todos os documentos; exigir trecho por claim |
| `mv6rcgyk-oc2r6` | Tentativas worker, download de áudio e Whisper com um segmento; resumo menciona música | Houve download/transcrição de áudio. Frames/OCR não aparecem neste registro; não confundir com falha universal do caminho atual |
| `mv6tgth6-0tovf` | Downgrade true sem fonte → unproven45, score79→71; nota ausente na UI | Controle de fontes foi usado nesse registro; serialização incompleta prejudica diagnóstico |

Artefato local adicional `tmp-dl/prod-check.json` foi examinado pelo revisor: contém frames/visão, opinião condicional incluída na média e fontes temáticas que não comprovam o nome de coligação citado. Os documentos públicos foram lidos pelo revisor; isso é análise de um resultado preservado, não benchmark nem nova execução da versão atual.

## 5. Contrato metodológico recomendado

1. **Receber e delimitar material:** origem, data, conteúdo real e modalidades disponíveis; metadados separados do alvo.
2. **Extrair claims:** texto literal e localização; separar opinião, previsão, condição e fato verificável.
3. **Recuperar evidências:** priorizar fonte primária quando apropriada, buscar suporte e refutação, preservar resultados sem inventar URLs.
4. **Vincular evidências:** trecho, localização, data, posição e justificativa por claim; diferença entre assunto semelhante e prova específica.
5. **Julgar suficiência:** evidência ausente, conflito, fonte inacessível e conteúdo ausente são estados distintos; mídia descrita não é autenticada automaticamente.
6. **Concluir:** status factual e limites; resumo fiel às afirmações/evidências. Não transformar indisponibilidade em acusação.
7. **Validar:** schema, vínculos, cobertura e consistência entre status, eventual nota, selo e texto.
8. **Registrar/publicar:** versão de metodologia, modelos reais por fase, cache de origem e correções transparentes.

Manter a terminologia pública atual até aprovar uma rubrica coerente. Não resolver inconsistência apenas renomeando “Distorcido”/“Parcialmente verdadeiro”. Separar factualidade, suficiência da evidência e cobertura; decidir se uma nota global ainda agrega valor após avaliação.

## 6. Plano de implementação priorizado

| Fase | Entrega | Arquivos/superfícies | Critério de aceite |
| --- | --- | --- | --- |
| 1 — Contratos críticos | Abstensão, schema, status/score/fontes, transcrição efetiva e score nos logs | scoring, verify, transcribe, checklog | Todos os casos sintéticos acima respeitam invariantes; mídia inacessível não vira enganoso; modelo enviado coincide com registro |
| 2 — Evidência e mídia | Proveniência da busca, trechos por claim, cobertura e conteúdo real | verify, media, entrada/API | Fonte temática não conta como prova específica; fala/texto visual analisados complementarmente; uploads são reais ou declarados indisponíveis |
| 3 — Modelos/configuração | Descoberta completa, capacidades, adapters, persistência e revisões | ai-config, APIs admin/dev, pipeline | Todos os IDs descobertos constam no inventário; incompatíveis bloqueados na UI/backend; falha ao salvar não aplica mudança; nova revisão não usa cache antigo como nova análise |
| 4 — Admin visual | Shell, navegação, tabela/cards, detalhe e estados | Admin.jsx, index.css, App.jsx, roteamento | Busca/lista acessível sem card de configuração no caminho; desktop/celular sem overflow; resposta tardia não reabre detalhe fechado |
| 5 — Avaliação e transparência | Benchmark humano, metodologia publicada, política de correções e privacidade | documentação, corpus/avaliação, admin | Resultados reproduzíveis por versão e modalidade; limites e correções acessíveis; nenhum percentual de precisão sem medição |

Fases 1–3 fornecem dados confiáveis para o redesign. Shell visual pode avançar em paralelo após contratos de campos definidos; evidência/fallback não devem aparecer como funcionalidades fictícias.

## 7. Protocolo de validação para a implementação

### Funcional e visual

- Exercitar admin real autenticado em 1440, 1024 e 390 px; busca, filtros, paginação, logout, teclado/foco e falhas de rede.
- Fechar detalhe durante carregamento e trocar rapidamente de registro; nenhuma resposta obsoleta altera seleção.
- Acesso direto e refresh da URL canônica funcionam em produção.
- Selecionar modelo compatível, salvar, reiniciar processo e confirmar configuração efetiva. Validar duas instâncias e prazo de propagação explícito.
- Inspecionar payload upstream para comprovar modelo/provedor/formatos reais; não validar somente etiqueta do retorno.
- POST incompatível não altera configuração; erro de Blob não altera silenciosamente o modelo em uso.
- Registros novos conservam score, proveniência e revisão; antigos são identificados como antigos, sem reclassificação disfarçada de nova pesquisa.

### Precisão factual e robustez

Proposta inicial: corpus de pelo menos 200 casos, balanceado por modalidade e categoria, separado por evento/origem para reduzir vazamento. Dois anotadores humanos independentes com adjudicação; LLM não é gabarito.

Incluir: fatos verdadeiros/falsos, recortes, número sem contexto, opinião/condicional, fontes conflitantes, fonte temática irrelevante, fonte primária única, vários documentos do mesmo órgão, mídia inacessível, música com texto na tela, fala e legenda divergentes, vídeo longo, upload e injection em texto/metadata/OCR/áudio.

Medir por fase: extração de claims, transcrição/OCR, recuperação e relevância da evidência, posição suporte/refutação, classificação, abstensão e cobertura. Reportar macro-F1/confusão, falso positivo acusatório, precisão de citações, estabilidade e intervalos de confiança por modalidade. Repetir subconjunto cinco vezes sem cache; cache-hit não mede consistência do modelo.

Gates determinísticos propostos: zero inconsistência de schema/status/nota; zero classificação acusatória por indisponibilidade; zero injection bem-sucedida nos cenários críticos. Metas estatísticas de precisão/relevância devem ser fixadas após baseline humano, não inventadas nesta auditoria.

Comparar provedores/modelos com mesmos materiais/evidências e versões de prompt. Publicar falhas e necessidade de revisão humana antes de atribuir maior qualidade a um modelo.

## 8. Referências primárias e limites

- [OpenCode Go: modelos, protocolos, uso e privacidade](https://opencode.ai/v2/docs/console/go/).
- [Inventário público Go](https://opencode.ai/inference/go/v1/models).
- [OpenAI: listagem de modelos](https://developers.openai.com/api/reference/resources/models/methods/list).
- [OpenAI: catálogo de modelos](https://developers.openai.com/api/docs/models).
- [OpenAI: GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna).
- [OpenAI: GPT-4o Transcribe](https://developers.openai.com/api/docs/models/gpt-4o-transcribe).
- [IFCN: imparcialidade, fontes, metodologia e correções](https://ifcncodeofprinciples.poynter.org/the-commitments).

Acesso ao inventário da conta OpenAI local foi observado; inferência bem-sucedida de todos os IDs e permissões da conta de produção não foram testadas. O inventário público Go não confirma todas as capacidades. Precisão factual global, resistência a injection e conformidade completa de acessibilidade não foram medidas. A fase de auditoria não realizou commit, push ou deploy; as mudanças funcionais executadas depois dela estão registradas na seção 9.

## 9. Status de implementação

A execução deste plano, com evidência por fase e pendências reais, está em
[Status de implementação](admin-status-implementacao.md).
