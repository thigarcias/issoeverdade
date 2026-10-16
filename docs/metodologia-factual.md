# Metodologia factual

**Contrato atual: `fact-check-21`.** Esta ferramenta automatiza a análise de afirmações; não substitui apuração, revisão profissional ou julgamento humano. Não há certificação ou afiliação ao IFCN declarada. Os smokes e auditorias de versões anteriores abaixo permanecem históricos, não são resultados desta atualização. Registros com versão `≤18` não são recalculados: `score: null` histórico continua legível como "sem nota".

## Fluxo efetivo e versão

As novas checagens usam `fact-check-21`. O fluxo configura/cacheia a entrada, aplica triagem de propósito e moderação, extrai mídia quando necessário e executa avaliação factual com busca web (`judge`); notícias podem receber pesquisa direcionada condicional (`article-research`). A pesquisa com fontes citadas é a avaliação principal. O servidor saneia fontes e evidências e calcula comparações antes da validação determinística. **A coleta documental independente está desativada por padrão**: somente `IEV_EVIDENCE_FETCH=1` ativa obtenção HTML/PDF (`evidence`), localização e revisão opcional (`evidence-review`). Nesse modo, a recuperação documental (`evidence-research`, `evidence-recovered`, `evidence-rereview`) busca lacunas sem alterar hipóteses existentes; slots vazios preservam a avaliação anterior. Falhas operacionais ou revisão não conclusiva não apagam pesquisa válida. Não há segunda avaliação audiovisual `final`, geração/revisão editorial nem troca automática de provedor após falha de inferência. Avaliação/pesquisa e visão usam GPT-6 Luna por padrão; transcrição, moderação e revisão documental JEV têm configurações próprias. Preferências persistidas válidas prevalecem.

Os controles incluem política de URL, triagem de propósito, moderação, cobertura declarada de vídeo, validação de mídia, proveniência de fontes e validação factual final. A moderação aplica a mesma política obrigatória a texto, contexto, artigo/PDF extraídos, metadados usados como conteúdo, transcrição/OCR e imagens/frames antes da etapa seguinte, sem corte silencioso: conteúdo acima do orçamento por chamada é dividido com sobreposição e cobertura real registrada, e acima do orçamento total retorna erro explícito. O cache só reutiliza resultado compatível com a política de moderação vigente (revisão determinística no namespace e no registro; registros sem identidade ou com época incerta não são servidos), e uma falha de cache segue para execução normal sujeita às mesmas políticas. A resolução da configuração de IA distingue bootstrap intencional de persistência indisponível ou inválida: outage reutiliza o snapshot conhecido com estado explícito ou falha antes da inferência paga, sem selecionar outro par. O [inventário de gates e riscos restantes](auditoria-gates-fluxo-2026-10-15.md) distingue bloqueios intencionais, guardas epistêmicas, enriquecimento opcional e persistência/entrega.

A entrada do modelo é tratada como material não confiável: instruções embutidas em texto, páginas, OCR e transcrição não devem alterar a tarefa. Isso é uma instrução e uma salvaguarda de prompt, não uma prova de resistência a prompt injection.

A versão e a revisão da configuração integram o namespace do cache, junto do fingerprint da política de moderação e da época de invalidação (`iev-cache-v2/epoch.json`): uma correção editorial invalidada pelo painel deixa de servir resultados antigos como versão vigente, e mudanças de modo, limiar, categorias ou cobertura de moderação invalidam reusos anteriores. Resultado criado sob política diferente não é entregue como compatível. Em outage da leitura da época, o cache é ignorado em vez de reutilizar a época anterior. Registros antigos não são reexecutados; quando não têm versão de metodologia, o painel os identifica como legados. Um registro preservado descreve aquela execução e não garante que uma execução atual repita a conclusão.

### Entrega por stream e recuperação sem nova inferência

O POST transmite eventos NDJSON `accepted`, `content`, `activity` e um terminal `result` ou `error`. O `checkId` aceito é o mesmo usado na execução, no log e no envelope de resultado; o evento `accepted` informa `recoveryAvailable` e, somente quando existe registro recuperável, entrega `recoveryToken`, gerado com 32 bytes criptograficamente aleatórios. O cliente mantém o decodificador UTF-8 entre chunks, processa a última linha mesmo sem `\n` no EOF (ou antes de uma falha de leitura) e não descarta um terminal já recebido por perda posterior da conexão. EOF sem terminal não significa sucesso.

Se faltar terminal e houver capacidade recebida, o cliente faz **um GET**, não um novo POST: `GET /api/verify?checkId=...`, segredo apenas em `X-Verify-Recovery`. Não há polling. A resposta é `200 {status:"completed",envelope}`, `202 {status:"pending"}`, `409` para falha ou `404` para capacidade inválida/expirada; falha do armazenamento pode produzir `503` e o controle de taxa, `429`. Pendência ou erro transitório preserva a capacidade para nova consulta **explícita**. Falha definitiva/expiração limpa a capacidade; só a próxima ação explícita pode iniciar nova checagem. O GET nunca inicia inferência, reserva orçamento/vaga de POST ou concilia tokens. Um POST com cache ainda passa pela admissão existente, mas não recontabiliza os tokens do resultado antigo.

A capacidade permanece apenas na memória da interface para a mesma modalidade, texto/contexto e identidade do arquivo. Alterar a entrada ou trocar de arquivo/aba a descarta; o resultado recuperado é anunciado como tal. O token não vai para URL, `localStorage`, histórico, compartilhamento ou logs administrativos. O envelope recuperável fica em Blob **privado** quando configurado, sem fallback silencioso após falha desse Blob, ou em memória limitada a 200 registros quando não há Blob. A chave de armazenamento é um hash de `checkId` e token, não o segredo literal. A autorização expira **30 minutos após a aceitação**; pendência ainda sem conclusão após **5 minutos** responde com falha de prazo. O prazo é lógico, não promessa de apagar fisicamente objetos Blob; memória pode perder registros antes disso por reinício ou limite.

O servidor tenta registrar a pendência antes de executar a análise, com prazo próprio limitado. Falha ou prazo excedido do registro inicial significa apenas **recuperação indisponível**: a análise autorizada segue e entrega progresso e resultado pelo stream com `recoveryAvailable: false`, sem token fictício e sem chamadas de `complete`/`fail`. Se apenas a gravação final falhar, o resultado válido ainda é entregue com `recoveryAvailable: false`; uma falha de recuperação não transforma uma análise concluída em veredito factual diferente, e a falha ao registrar o erro preserva o erro primário. Recuperação consulta somente o registro autorizado, não busca resultado por entrada nem consulta logs administrativos.

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
Essa etapa complementar é encapsulada: falha operacional, prazo ou JSON inválido
da segunda pesquisa preserva a primeira avaliação elegível (ou devolve a
limitação correspondente quando não há avaliação utilizável), com aviso
operacional separado; um resultado adicional vazio não apaga afirmações já
identificadas, e a base preservada passa pelo mesmo saneamento e validação.
Não há retries nem troca de provedor, e o tempo da etapa cabe no orçamento
restante da execução.
Isso não garante que o provedor devolva fontes utilizáveis; os diagnósticos de
pesquisa registram o ocorrido. URL, título, publicação/site e trechos orientam
a identificação de alegações, não provam o conteúdo. A síntese declara quando
o artigo integral não foi lido. Uma notícia não termina como mídia inacessível
só por falha de acesso: sem alegações identificáveis, `insufficient_input`;
claims identificados sem evidência suficiente ficam `unproven`. A revisão de
extração `article-content-v4` integra o cache; as regras de perguntas e ações futuras introduzidas em
`fact-check-5` foram refinadas em `fact-check-12` e mantidas, com a delimitação de escopo reforçada, na metodologia atual `fact-check-21`. Resultados do namespace anterior
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

Essas pontuações são históricas, anteriores à abstenção agregada de `fact-check-7` e à nota de abstenção de `fact-check-19`: na época, checagens com afirmações sem comprovação ou omitidas não recebiam nota global. Os registros acima não foram reexecutados nem recalculados.



### Perguntas, rumores e ações futuras

`fact-check-12` mantém a investigação de hipóteses factuais implícitas em perguntas, inclusive informais, e corrige sua delimitação: se a pergunta contiver um rumor identificável, verifica-se **o próprio rumor**, não uma hipótese inventada de anúncio, declaração ou medida recente. Verbos no futuro não obrigam prever o que acontecerá nem tornam a pergunta automaticamente `no_verifiable_claims`. Declarações, propostas, medidas e desmentidos documentados são pesquisados conforme a alegação efetivamente apresentada.

O claim deve preservar sujeito, ação, objeto e alcance, sem inventar fala, alvo ou período atual. Um caso individual não identificado fica em `notCheckedClaims`; isso não impede investigar a alegação geral. Um desmentido direto e fundamentado, inclusive de agência de checagem, pode refutar o mesmo boato ainda que antigo, se objeto, alcance e condições coincidirem e a pergunta não especificar nova ocorrência. A data de publicação sozinha não reduz a fonte a contexto e não deve ser usada como período de referência do fato. Se o usuário indicar nova medida, declaração, data ou evento, desmentido de ocorrência anterior não basta automaticamente: é necessária evidência correspondente. Rótulos “fake news”, manchetes ou notícias apenas sobre o mesmo tema não resolvem qualquer alegação. Não se exige provar que uma ação jamais ocorrerá, mas ausência de anúncio ou de evidência não prova falsidade. Sem evidência adequada, o claim fica `unproven`. Opiniões e previsões puras continuam sem pontuação factual; os controles de segurança não foram relaxados.

`fact-check-21` explicita a correspondência entre o escopo da pergunta e o da prova. Pergunta e afirmação equivalentes preservam a mesma hipótese; forma interrogativa, capitalização e pontuação não mudam o objeto analisado. Refutar a autenticidade de um vídeo, uma fala atribuída ou uma ocorrência específica não refuta automaticamente o fato mais amplo que esse material pretendia demonstrar. O agente deve preservar a alegação original, usar como contexto um desmentido que não a resolva e explicar separadamente o que foi refutado e o que continua sem comprovação. Ambiguidades como reduzir valor, reduzir beneficiários, extinguir ou mudar regras não autorizam escolher silenciosamente um sentido. Desmentido integral do mesmo rumor continua elegível para `false`, sem exigir garantia sobre todo futuro. As regras de pontuação da versão 20 permanecem; a nova versão separa o cache e não recalcula registros históricos.

**Comparação local v20 → v21 em 16/10/2026.** Mesmo modelo real `opencode:gpt-6-luna`, sem respostas simuladas. Dez chamadas compararam a etapa `judge` com busca web: duas rodadas por versão da pergunta “o flavio vai cortar o bolsa família?” e da afirmação equivalente, mais uma por versão sobre a autenticidade do vídeo descrito. Resultados brutos do modelo:

| Entrada / rodada | v20 | v21 |
| --- | --- | --- |
| Pergunta / 1 | `unproven` 45 | `unproven` 45 |
| Pergunta / 2 | `unproven` 45 | `unproven` 45 |
| Afirmação / 1 | `unproven` 45 | `unproven` 45 |
| Afirmação / 2 | `false` 5 | `unproven` 45 |
| Autenticidade do vídeo descrito / 1 | `false` 5 | `false` 5 |

A resposta antiga `false` vinculou a alegação ampla ao vídeo manipulado; as quatro respostas novas às entradas amplas explicitaram os sentidos possíveis de “cortar”. O controle sobre o vídeo continuou refutado pelo modelo. As buscas retornaram fontes diferentes: este lote pequeno não isola causalmente o efeito do prompt, não comprova estabilidade geral e não autentica o vídeo. A comparação da etapa juiz não executou saneamento de produção, auditoria documental ou validação final.

Outras 24 chamadas reais usaram seis cenários inteiramente fictícios, corpus fechado idêntico e duas repetições por versão: alegação ampla/pergunta equivalente com vídeo fabricado, fala explicitamente fabricada, refutação documental abrangente, declaração sustentada e ocorrência de outro período. Ambas as versões preservaram o escopo e o status esperado em 12/12 respostas; esse recorte não demonstrou ganho de classificação. Em uma resposta v21, o juiz emitiu `false` com nota 98; o replay das respostas pelo validador atual corrigiu essa nota para 5, sem mudar os status. Esse corpus é um ensaio de escopo, não benchmark factual.

Um smoke separado executou `runVerify` completo com busca real para a pergunta ampla: `fact-check-21`, `checked/unproven`, nota 49, uma afirmação no escopo original e justificativa sobre a ambiguidade. A gravação do registro ficou indisponível porque o ambiente local não tinha a chave de serviço do armazenamento; a avaliação concluiu. Verificação de código: 452 testes aprovados; build concluído com aviso de chunk acima de 500 kB; lint com 17 avisos React. Relatórios locais ignorados pelo Git: `tmp-dl/scope-live-compare.json` e `tmp-dl/scope-controlled-compare.json`, com prompts, hashes, entradas e respostas brutas. Scripts temporários removidos.

Registro histórico, anterior a essa correção: no smoke real da pergunta “o lula vai fechar a minha igreja???”, o resultado foi `checked`, com claim geral `unproven`, pesquisa sobre declarações/medidas e caso individual registrado como não checado; o desmentido de 2022 foi usado como contexto. Essa execução não foi reexecutada e não valida a delimitação atual: agora o mesmo rumor pode ser refutado por desmentido documental correspondente, sem presumir um anúncio atual. Não há garantia de resposta idêntica em todas as execuções do modelo.

Smoke local de `fact-check-12`: o extrator real obteve o [artigo da AFP de 22/10/2024](https://checamos.afp.com/doc.afp.com.36KN79E) com HTTP 200. Duas alegações inicialmente `unproven` — sobre defesa de fechamento de igrejas nos discursos do vídeo e sobre o rumor de fechamento de todas as igrejas — usaram trecho literal localizado, receberam `refutes` do JEV real e terminaram `false`, nota 5, após revisão e validação.

Uma execução completa de `runVerify` com “O Lula vai fechar igreja?”, GPT-6 Luna e JEV reais, retornou `checked/false`, nota 5, uma afirmação refutada e duas fontes (AFP e Aos Fatos), em 15.975 ms. Os dois documentos foram obtidos, mas somente a citação de Aos Fatos ficou documentalmente elegível nessa execução; a citação AFP gerada pelo modelo não foi validada. Isso distingue o smoke documental anterior do resultado da pesquisa completa. Armazenamento compartilhado foi desabilitado apenas no processo do smoke; nenhum registro antigo foi alterado. Esses casos não medem taxa geral de abstenção ou precisão, nem comprovam implantação.

Outro cenário real revelou perda de contexto: a janela enviada ao revisor começava na citação e descartava o sujeito e a data anteriores. O JEV escolheu `supports` com 0,53, abaixo do limiar, para a afirmação documentada sobre Estado laico em 2022. A janela agora distribui o espaço antes e depois da citação, preservando-a e mantendo o teto. Com essa mudança, o mesmo caso recebeu suporte e terminou `true`; uma alegação de novo decreto em 2026 continuou `unproven` com o artigo antigo. Os limiares não foram reduzidos.

Após o ajuste da janela, a pergunta completa foi executada novamente: GPT-6 Luna e JEV retornaram `checked/false`, nota 5, uma afirmação refutada, com AFP e UOL Confere. Os dois documentos foram obtidos e as duas citações localizadas; tempo de 16.720 ms. A suíte completa anterior ao último ajuste da janela passou com 254 testes, após isolar as variáveis de armazenamento herdadas que afetavam um teste administrativo; depois desse ajuste, os 119 testes dos módulos afetados passaram. O lint executado não apresentou erros, com dez avisos React em arquivos não alterados. A página pública da metodologia foi conferida no navegador local.


## Fontes e limites de evidência

Uma fonte só permanece quando sua URL HTTP(S) específica aparece em uma anotação `url_citation`, em `web_search_call.action.sources` ou em uma ação `open_page` concluída retornada pelo provedor, não é uma homepage genérica e está vinculada a uma afirmação. A requisição de busca solicita `include: ["web_search_call.action.sources"]`. A pesquisa direcionada condicional pode reutilizar a proveniência da avaliação factual; URLs que aparecem apenas no JSON escrito pelo modelo não são aceitas. URLs inválidas, genéricas, sem proveniência ou sem vínculo são descartadas.

A evidência usa relação `supports`, `refutes` ou `context`, identificador de fonte e trecho. O servidor exige fonte vinculada e saneada, relação reconhecida e trecho de pelo menos oito caracteres. Na avaliação principal, `assessmentBasis: "web_research"` e `verification: "research"` significam **trecho informado pelo pesquisador com URL na proveniência da ferramenta**, não texto bruto de página obtido ou conferido pelo servidor. `assessmentNote` explica a base aplicada. Esses campos de autoridade são definidos pelo servidor, não aceitos do JSON do modelo. Proveniência não garante leitura da página pelo modelo, fidelidade da citação, autenticidade da fonte ou pertinência semântica; não afirmamos que todas as citações sejam fiéis.

Somente com `IEV_EVIDENCE_FETCH=1` o servidor obtém documentos das fontes (até `IEV_EVIDENCE_MAX_DOCS`, com tetos de bytes por documento/job), extrai HTML/PDF e localiza o trecho por comparação literal, normalizada ou aproximada. O resultado distingue `exact`, `normalized`, `approximate`, `prefix`, `tokens`, `missing`, `empty_quote`, `document_unavailable` e `not_fetched`. Desativar esse coletor não desativa a leitura do material enviado: artigo de entrada, PDF, imagem e mídia continuam usando seus leitores e limites próprios.

Falha HTTP, timeout, limite documental, falta de grupo ou revisão indisponível/inconclusiva permitem conservar a avaliação principal **se ela já era conclusiva e tem evidência de pesquisa elegível**; não promovem `unproven`. Uma divergência explícita de localização em documento obtido torna aquela citação inelegível para o fallback; corte ou página incompleta não são prova de falsidade. Faltam fontes/trechos, há conflito ou períodos conhecidos disjuntos? A alegação permanece sem comprovação. A auditoria opcional não pode fabricar localização nem chamar `research` de `verified`.

O coletor compartilha cache por URL, teto de documentos e orçamento de bytes na checagem; o mesmo documento não é baixado duas vezes. A revisão recebe os trechos localizados, sem promover trechos não localizados a prova. Esgotar o teto mantém `document-limit`; isso não prova falsidade. HTML com `NewsArticle`/`Article` reutiliza a extração de `articleBody`, título e data publicados no JSON-LD; outros scripts continuam descartados. Isso recupera conteúdo fornecido pela página, não autentica a publicação nem contorna paywall.

A janela de contexto da revisão inclui texto anterior e posterior à citação, dentro de `IEV_EVIDENCE_EXCERPT_CHARS`, para não descartar sujeito, período ou ressalvas adjacentes. Isso não equivale à leitura integral nem garante que todo contexto necessário caiba no limite.
Na versão 15, o início obtido do mesmo documento acompanha a janela, limitado a `IEV_EVIDENCE_EXCERPT_CHARS` (700 caracteres por padrão), para resolver identidade/atribuição e contexto temporal não adjacentes. Não substitui citação localizada nem autoriza transferir provas de outro claim. A revisão exige implicação do que foi afirmado, não reprodução integral dos detalhes compatíveis da fonte; silêncio sobre implementação não afirma imediatismo ou ausência de transição.

Em `fact-check-13`, título, URL e data de publicação obtidos da própria página acompanham os trechos da revisão; o período alegado é informado separadamente e não é prova. A data publicada ajuda a interpretar referências relativas explícitas, mas não estabelece sozinha a data do evento. Metadados sem texto pertinente não comprovam o corpo ausente.

A localização também aceita omissões editoriais explícitas (`[...]`, `[…]`, `[ ... ]`, `(...)`): 1–4 fragmentos literais após normalização, em ordem, inclusive cortes nas bordas. Cada fragmento exige pelo menos duas palavras, seis letras/dígitos e uma âncora não trivial; o conjunto exige 40 caracteres e oito palavras. Cada lacuna interna é limitada a 240 caracteres normalizados, o intervalo a 1000 e a busca a 128 candidatos. O registro usa `approximate`; não reconstrói palavras omitidas e mantém o intervalo literal integral e a janela contextual. Tags inline não criam espaços artificiais antes de pontuação em nomes/palavras; números separados não são concatenados em decimais. Nada disso implica suporte semântico automático.

A avaliação inicial e a revisão distinguem fato processual de culpa: fonte que documenta prisão e condição de suspeito pode confirmar essa afirmação sem comprovar o crime. Não se exige condenação quando ela não foi alegada; tampouco se confirma culpa ou condenação com uma notícia de suspeita. Atribuição de fala ou estimativa também não comprova seu conteúdo. Na versão 13 os limiares não foram alterados; o ajuste da versão 15 está descrito abaixo. Evidência e limites da mudança original constam na [auditoria de abstenções de 15/10/2026](auditoria-sem-comprovacao-2026-10-15.md).

Em `fact-check-14`, uma citação direta atribuída explicitamente no texto obtido pode sustentar “X declarou Y”, quando sujeito, conteúdo e escopo coincidem. Isso vale para o relato factual dentro de coluna de opinião ou reprodução de outra publicação, sem aceitar automaticamente o veículo ou suas opiniões. Não se exige áudio/vídeo original para autenticar uma mídia que não é objeto da afirmação. A atribuição contestada, hipotética, satírica ou negada exige tratamento próprio; documentar a fala não comprova seu conteúdo, sinceridade, execução ou manutenção atual. Autenticidade/edição de um vídeo específico continua sendo outra afirmação. Tampouco documentar uma fala de X prova que outra pessoa nunca a disse: falta de suporte não equivale a refutação.

Na auditoria documental opcional, URLs de vídeo/áudio sem transcrição apta registram `media-transcript-unavailable`; HTML/metadados não provam uma fala. A pesquisa deve procurar reportagem textual, documento ou transcrição sem simular leitura audiovisual. A impossibilidade fica registrada separadamente; pode subsistir pesquisa primária elegível, sem declarar que a mídia ou o documento foram conferidos e sem trocar o provedor de revisão.

Montagens de manchetes podem conter hipótese factual de incompatibilidade entre posições. As regras extraem as falas, a comparação, motivações atribuídas e autoria/fidelidade das publicações separadamente; somente o juízo de caráter fica em `notCheckedClaims`. Datas ausentes não são inventadas. Comparação qualitativa requer documentação dos dois lados no mesmo objeto, alcance, condições e contexto pertinente, mas não exige `comparison` aritmético. A existência de dois títulos autênticos não estabelece automaticamente contradição nem causa eleitoral. Essas regras de modelo reduzem omissões, mas não garantem precisão factual ou uma conclusão sobre uma imagem específica sem pesquisa bem-sucedida.

A revisão documental opcional recebe **um grupo por claim**, com alegação integral, trechos localizados e cálculo quando houver. Não se transferem provas entre claims. A resposta usa `{claims:[{claimIndex,verdict,note}]}`, com `verdict` em `supports|refutes|context|unclear`; `claim.evidenceReview` registra relação, verificação, incompletude e índices. Grupo completo e validamente revisado com `supports` ou `refutes` é autoridade documental e resolve `true` ou `false`, mesmo contra o palpite inicial; `context` documental conclusivo resolve `unproven`. A base passa a `assessmentBasis: "document_review"`. Grupo ausente, incompleto, duplicado, indisponível ou ambíguo não dá confirmação documental: aplica-se a pesquisa principal elegível, se houver, sem promover uma hipótese inicialmente sem comprovação. Comparações continuam exigindo seus controles próprios.

Quando a coleta é explicitamente ativada e há trechos aptos, a revisão usa por padrão JEV (`jev-1.13-free`) via OpenCode/SystemOne. `IEV_EVIDENCE_REVIEW_PROVIDER=jev|judge` seleciona o provedor; modelo e habilitação da revisão têm configuração própria. Não há troca automática para outro revisor se falhar: o fallback é a pesquisa principal válida, não nova inferência em outro provedor. Os limiares da versão 15 permanecem no caminho JEV: classe máxima de pelo menos **0,7** e margem de **0,2**. O piso anterior era 0,8; replays históricos com suporte entre 0,61 e 0,74 motivaram a alteração. Ambiguidade não é refutação. Não foi demonstrada calibração ou precisão geral. A [revisão integral v15](revisao-algoritmo-factual-2026-10-15.md) preserva a evidência e os limites históricos.

Em `fact-check-15`, `IEV_EVIDENCE_REVIEW_ITEMS` limita cada grupo, não uma fatia global que exclui as alegações seguintes. Grupos inteiros são empacotados em lotes; grupo que excede o teto fica explicitamente incompleto. JEV usa um prazo total para os lotes e não entrega confirmação parcial se um lote falhar.

Com coleta/revisão optadas, a passagem única de cobertura/recuperação usa o mesmo pesquisador, documentos limitados a 12 mil caracteres cada/36 mil no conjunto e até 24 mil caracteres da entrada disponível. Não altera texto, período nem comparação das hipóteses existentes. Novas alegações exigem `inputQuote` literal e começam `unproven`; o fallback de pesquisa não as promove automaticamente. Candidatos passam por saneamento e pelos mesmos limites documentais. Só grupos com conteúdo localizado novo recebem nova revisão. Falhar a recuperação não descarta a pesquisa válida já disponível. O passo acrescenta custo/latência e não garante completude.

A indisponibilidade documental é registrada por alegação, separada da classificação factual; revisão de outro claim não valida este. O cache de 24 horas não reutiliza claims `unproven` sem revisão documental verificada; isso também exclui abstenções da pesquisa principal. Contexto documental revisado, mas insuficiente, pode ser cacheado. Pesquisa conclusiva elegível pode ser cacheada sem auditoria independente. Registros históricos são preservados. Pesquisa/decomposição variam; recuperação não prova completude e nota não é taxa de precisão.

No caminho de pesquisa, `verification: "research"` só é elegível com `assessmentBasis: "web_research"`. Na revisão agrupada documental, os trechos ficam `relation: "context"` e `verification: "verified"` registra localização e participação em grupo validamente revisado, **não suporte/refutação independente de toda a alegação**. `unavailable`/`unclear` descrevem limitações documentais, não invalidam automaticamente pesquisa primária válida. A relação documental pertence a `claim.evidenceReview`; `evidenceSupport` resume suporte elegível. Dados históricos podem não conter os novos campos. Nenhuma dessas marcas autentica a fonte ou comprova seu contexto integral; `coverage` mede alcance da avaliação.

**Isso não prova que a fonte esteja errada nem que a citação seja fiel ao contexto integral.** Ausência de trecho é limitação registrada, nunca falsidade: paywall, página que exige JavaScript, PDF sem texto extraível, tradução e paráfrase aparecem como `document_unavailable`/`missing`. A revisão por modelo é defesa adicional, não validação humana, e não substitui o corpus humano anotado.

O registro preserva consultas, URLs estruturadas e diagnóstico por etapa: busca não solicitada, nenhuma chamada registrada, chamadas sem URLs rastreáveis ou proveniência disponível. Também preserva contagens de anotações/resultados e IDs/status/tipos/URLs tentadas das chamadas, não o envelope bruto completo ou todo conteúdo de páginas. Tentativa de abertura que falhou não qualifica uma URL como evidência. Uma URL retornada pela ferramenta demonstra proveniência, não pertinência semântica nem prova do trecho. A qualidade da busca e a seleção de fontes primárias ainda podem falhar.

### Comparação temporal

Os prompts distinguem publicação, coleta/referência, rodada anterior/atual, votos totais/válidos, percentuais/pontos percentuais e intenção de voto/rejeição. Datas relativas devem usar a data do material original, não automaticamente a data da checagem. Quando conhecidos, claims e evidências incluem `referencePeriod` com início/fim ISO. A data de publicação de um desmentido não é automaticamente o período de referência do rumor: fonte antiga pode tratar do mesmo boato, enquanto nova ocorrência especificada exige correspondência temporal e de escopo. O servidor converte suporte/refutação de períodos disjuntos em contexto; sem outra evidência compatível, rebaixa a classificação e substitui a justificativa contraditória. Datas ausentes não são inventadas. Esse controle é estrutural: não valida independentemente as datas nem garante que intervalos sobrepostos sejam semanticamente comparáveis.

#### Aritmética anual com operandos vinculados

A proposta `claim.comparison` identifica `metric`, `region`, `unit`, `dataset`, `operator` (`greater_than|less_than|equal`) e exatamente dois `groups`, cada um com `label`, `startYear`, `endYear` e `rows`. Cada linha usa `{year,valueText,numberFormat:"pt-BR"|"en-US",scale:1|1000|1000000,evidenceId,complete:boolean}`. `evidenceId` deve resolver inequivocamente para evidência do próprio claim: trecho documental elegível ou citação explicitamente de pesquisa, **sem inventar localização**. Ano, valor literal, unidade e escala devem estar próximos nesse trecho; aceitar texto informado pela pesquisa não é conferir o valor na página. Valores não negativos, até seis casas decimais e precisão segura; anos duplicados, sobrepostos, futuros, fora do período ou escopos incompatíveis invalidam o cálculo.

`row.numberFormat` segue a fonte: `9,001` significa 9001 em `en-US` e 9,001 em `pt-BR`; a grafia ambígua exige formato explícito. Rótulos de indicador, região, dataset e grupos não precisam aparecer literalmente na citação. Homogeneidade declarada é validação estrutural; sem auditoria independente, significado, universo e contexto ainda dependem da pesquisa. No caminho documental, a revisão agrupada confere esses aspectos nos trechos. Área de floresta queimada, área de toda vegetação, desmatamento e focos de incêndio não são intercambiáveis.

O servidor soma os operandos com aritmética decimal exata, não com um total proposto pelo modelo. O resultado inclui `status: complete|lower_bound|partial|invalid`, `eligible`, `relation`, `scope`, `reason`, `equalLength` e, por grupo, `total`, `rows` com `value` calculado e `coverage: {expected,available,complete,missingYears}`. `complete` em uma linha significa total anual efetivo; o ano corrente é sempre tratado como incompleto. Totais completos de janelas de durações diferentes aparecem como `scope: "shorter_recorte"`, não como períodos equivalentes. A alegação original não pode ser substituída silenciosamente por uma comparação de recortes menores.

`partial` mostra os dados disponíveis, sem extrapolar, e não conclui períodos completos. `lower_bound` limita-se a área aditiva não negativa: um subtotal incompleto só estabelece desigualdade se já superar o total completo do outro lado. Não prova igualdade, total, previsão, porcentagem ou contagem convertida em área; dois lados incompletos não bastam. Mesmo `complete` ou `lower_bound` exige a mesma relação semântica no escopo exato: revisão agrupada válida no caminho documental; no caminho de pesquisa, evidência de pesquisa vinculada para **todas** as linhas e concordância entre classificação primária e cálculo. A soma exata não autentica seus operandos.

### Síntese legível e compartilhamento

As justificativas mantêm fatos e limites em pt-BR, não comentários internos sobre extração de claims, revisão ou ajustes de nota. Pedido, negociação, promessa e recebimento de dinheiro são ações distintas; uma notícia sobre suspeita ou investigação não comprova, por si, o fato investigado. Fontes indiretas e compilações devem ter seu alcance explicado e não substituem automaticamente o documento original. Os trechos citados continuam literais no idioma da fonte; a justificativa explica seu significado em português, sem inventar uma tradução literal.

Em `fact-check-11`, a síntese das checagens avaliadas é construída deterministicamente depois da validação: apresenta contagens por classificação e até três alegações com seus estados finais, sem reutilizar o resumo preliminar do modelo. Afirmações omitidas e limitações de leitura de artigos/posts continuam declaradas. Quando a classificação muda, justificativas incompatíveis não são reaproveitadas: usam os limites documentais consolidados ou a nota da revisão do próprio grupo. Não há geração editorial nem uma segunda chamada para revisar a síntese. Estados sem avaliação factual conservam suas mensagens operacionais.

**Histórico, não fluxo atual:** `fact-check-9` e `fact-check-10` usavam chamadas de geração e revisão editoriais depois da consolidação; `fact-check-10` também revisava justificativas. Esse contrato foi substituído em `fact-check-11`. Os smokes dessas versões ao fim deste documento descrevem somente aquelas execuções.

O PNG e o texto compartilhado usam a alegação efetivamente checada como título, em vez de uma pergunta que possa insinuar um fato mais amplo. O card prioriza a justificativa em português, identifica citações como trechos originais e mantém a fonte atribuída; para uma alegação sem comprovação, o trecho aparece como contexto, não como prova, com a nota na faixa 35–54 decidida pelo modelo. O texto compartilhado também inclui a síntese e o endereço de correções. Estados sem avaliação factual não recebem nota nem selo de verdade no compartilhamento. O PNG é uma síntese de espaço limitado; o resultado completo conserva as alegações e fontes.

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

Na versão 16, `true` e `false` elegíveis recebiam as notas de referência **95** e **5**; `context` da pesquisa normaliza para `unproven`, não 70. A revisão documental completa e conclusiva continua prevalecendo: `supports` resolve `true`, `refutes` resolve `false`, `context` resolve `unproven`, independentemente do palpite inicial. Revisão não conclusiva/indisponível recorre à pesquisa elegível, não rebaixa automaticamente por falha operacional. A âncora histórica `context` **70** permanece legível em registros antigos. Na versão 19, `unproven` avaliado recebia a nota fixa **45** (meio da faixa 35–54). Na versão 20, o **modelo escolhe a nota dentro da faixa do status** conforme a força da evidência: `true` 90–100, `false` 0–14, `unproven` 35–54; nota mais alta na faixa indica evidência mais completa/direta/convergente, nota mais baixa indica evidência parcial/indireta/com ressalvas. O servidor valida o status (vínculos estruturais) e a faixa; fora da faixa, aplica o fallback neutro — 95 para `true`, 5 para `false`, **45 para `unproven`** (meio da faixa, não valor fixo). Não existe `null` para claim avaliado. Ausência de nota não é zero nem falsidade.

O resultado inclui `coverage: { total, assessed, unproven, omitted }`, distinguindo o total de afirmações, as avaliadas com nota, as sem comprovação e as omitidas. `assessed` conta os claims com score numérico — com claims presentes, equivale a `claims.length`, porque todo claim avaliado agora pontua. A cobertura mede o alcance da avaliação, não o suporte factual. Cada claim inclui `evidenceSupport`: `supports`, `refutes`, `context` ou `insufficient`, que descreve a relação da evidência com a afirmação.

Suporte e classificação não são aliases: uma alegação sem comprovação pode ter contexto e ainda assim receber nota na faixa 35–54, decidida pelo modelo. Trechos documentais indisponíveis/inconclusivos não são prova documental; uma citação de pesquisa elegível pode sustentar a avaliação principal com seu rótulo próprio. Suporte e refutação simultâneos impedem classificação pontuada enquanto o conflito não for resolvido.

Cada afirmação é validada contra suas próprias fontes, texto e período. Não há segunda avaliação audiovisual para reformular claims; a recuperação textual opcional só acrescenta hipótese com âncora literal na entrada. Ausência de evidência elegível mantém a classificação `unproven` (com nota na faixa 35–54 decidida pelo modelo); ausência de auditoria independente, sozinha, não apaga pesquisa válida. Evidência histórica da revisão documental permanece no [relatório v15 de 15/10/2026](revisao-algoritmo-factual-2026-10-15.md); riscos e demais gates estão na [auditoria do fluxo](auditoria-gates-fluxo-2026-10-15.md).

Em `fact-check-17`, a nota geral exigia cobertura mínima de **0,5** (`coverage.assessed / coverage.total >= 0.5`) e calculava a média somente das afirmações com nota. Em `fact-check-20`, o limiar de 0,5 permanece, e a nota geral é a média aritmética arredondada de **todos** os claims com score numérico — cada claim entra com a nota decidida pelo modelo dentro da sua faixa, sem exclusão nem zero. Um claim `false` mantém o teto geral de 64. Abaixo de 50% (só possível via omissões, pois todo claim avaliado pontua), o resultado se abstém: `score: null`, `verdict: "unproven"`. `score: null` com `verdict: "unproven"` também ocorre quando `coverage.total === 0`, isto é, nos estados sem claim factual avaliado (`insufficient_input`, `no_verifiable_claims`, `inaccessible_media` sem alegação identificável etc.). Isso não transforma evidência de contexto em suporte ou refutação; um resultado com uma única afirmação sem comprovação recebe a nota que o modelo escolheu na faixa 35–54. Registros históricos (v≤18, `score: null`) não são recalculados; a nova versão separa o cache das novas checagens.

Em `fact-check-18`, rumores sobre medidas futuras são avaliados como informação em circulação, sem exigir prova de que a ação jamais ocorrerá. Uma checagem que desmente o mesmo rumor e descreve a apuração dos registros, da fala ou do documento invocado pode fundamentar `false`/`refutes`. A negativa isolada de um interessado, o silêncio de um plano ou a falta de anúncio não bastam. Previsão independente de rumor, nova ocorrência e objeto diferente continuam exigindo evidência própria. Não há promoção automática por palavras-chave no servidor.

Em `fact-check-19`, a faixa 35–54 voltou a ter nota nas checagens novas com o valor fixo **45**. Em `fact-check-20`, o modelo escolhe a nota dentro da faixa do status: a nota de abstenção de um `unproven` é a **nota na faixa 35–54 decidida pelo modelo**, não um valor fixo; 45 continua apenas como fallback neutro (meio da faixa) aplicado pelo servidor quando a nota sai da faixa. A nota de abstenção registra que a apuração não encontrou base suficiente — não é probabilidade de a afirmação ser verdadeira nem "meio-termo" entre verdadeiro e falso — e a falta de evidência continua não equivalendo a falsidade. Exemplo: um `true` (92) com um `unproven` (40) dá média (92 + 40) / 2 = 66; com um `false` (5) e um `unproven` (40), a média (5 + 40) / 2 = 22,5 (arredondada para 23) respeita o teto 64. Os avisos de calibração abaixo continuam valendo.

As faixas numéricas continuam disponíveis para resultados com nota e para exibir o histórico; nas checagens novas, cada status recebe nota dentro da sua faixa, decidida pelo modelo (`true` 90–100, `false` 0–14, `unproven` 35–54), com fallback neutro 95/45/5 fora da faixa:

| Score | Rótulo |
| ---: | --- |
| 90–100 | Verdadeiro |
| 75–89 | Maioria verdadeira |
| 65–74 | Parcialmente verdadeiro |
| 55–64 | Distorcido |
| 35–54 | Sem comprovação (nas checagens novas, nota na faixa decidida pelo modelo; 45 só como fallback neutro) |
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

Os "sem nota" abaixo são históricos (regra vigente na v7); em `fact-check-20`, os mesmos casos avaliados receberiam nota dentro da faixa do status (unproven na faixa 35–54, decidida pelo modelo) e média global com essas notas incluídas.

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
