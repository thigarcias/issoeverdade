# Plano de implementação — segurança e resiliência do workflow

## Objetivo e estado

**Estado: contratos implementados; evidência histórica e smoke desta revisão separados abaixo. Não há deploy em produção por este documento.**

Corrigir os gates identificados na [auditoria do fluxo `fact-check-16`](auditoria-gates-fluxo-2026-10-15.md), nesta ordem: moderação, cache, recuperação inicial em Blob, pesquisa adicional de artigos e resolução da configuração de IA.

A versão 16 já tornou a coleta documental independente opt-in e preserva pesquisa primária elegível quando a auditoria opcional fica indisponível. Este plano não refaz essa mudança e não presume deploy em produção.

### Princípios que não podem regredir

- Falha operacional não significa falsidade nem refutação.
- Uma dependência complementar não deve apagar um resultado válido.
- Moderação obrigatória, SSRF, autenticação, limites de entrada, capacidade e orçamento continuam bloqueantes quando não puderem ser garantidos.
- Não inventar evidência, verificação documental, capacidade de recuperação ou sucesso de persistência.
- Não trocar automaticamente de modelo/provedor após erro de inferência.
- Preservar proveniência, vínculo por afirmação, datas, conflitos, completude e cálculo determinístico. Fallback não promove hipótese sem comprovação.
- Separar validação funcional de precisão factual: os testes deste plano não constituem benchmark humano do modelo.

## Ordem de entrega

| Entrega | Prioridade | Resultado esperado | Dependência |
| --- | --- | --- | --- |
| 1. Moderação uniforme | P0 — segurança | Nenhum caminho obrigatório ignora erro ou corta conteúdo silenciosamente | Nenhuma |
| 2. Cache compatível com política | P0 — segurança | Resultado antigo não contorna a política vigente | Contrato da entrega 1 |
| 3. Recuperação inicial não bloqueante | P1 — disponibilidade | Blob de recuperação indisponível não impede inferência permitida | Limites/autorização continuam operacionais |
| 4. Pesquisa adicional recuperável | P1 — disponibilidade | Falha de enriquecimento preserva a primeira avaliação elegível | Nenhuma dependência funcional de Blob |
| 5. Configuração de IA previsível | P2 — previsibilidade | Indisponibilidade não seleciona silenciosamente outro par | Nenhuma |

Entregar e verificar cada contrato separadamente. As entregas 3 e 4 podem ser implementadas em paralelo após delimitar a propriedade de `server/verify.js` e `server/endpoint.js`; não misturar edições concorrentes no mesmo bloco. Não adiar as correções de segurança por conveniência de paralelização.

## 1. Uniformizar moderação

**Áreas:** `server/moderation.js`, aquisição de entrada e artefatos em `server/verify.js`, contratos do endpoint e testes relacionados.

### Implementação

- [x] Inventariar os dados efetivamente encaminhados à visão, transcrição e avaliação factual: texto/contexto, artigo/PDF extraídos, metadados utilizados como conteúdo, imagem/frames e transcrição/OCR.
- [x] Aplicar a mesma política de moderação obrigatória a cada caminho controlado pela aplicação, antes de a próxima etapa consumir o conteúdo. Fechar o desvio do PDF de entrada.
- [x] Remover o corte silencioso em 4.000 caracteres. Dividir texto significativo dentro do orçamento, preservando fronteiras Unicode e sobreposição explícita, sem perder conteúdo depois de sequências extensas de espaços. Registrar somente chunks efetivamente processados e tentativas realizadas, inclusive em falha parcial; cobertura planejada não é cobertura executada. Divisão não garante interpretação idêntica à leitura integral.
- [x] Se o conteúdo exceder o orçamento de processamento seguro, devolver limitação/erro explícito; não analisá-lo como se tivesse sido integralmente moderado.
- [x] Padronizar três resultados: permitido, recusado pela política e serviço indisponível. Exceção inesperada em modo obrigatório vira erro operacional, nunca autorização implícita por `.catch(() => null)`.
- [x] Preservar a cobertura declarada para vídeo; amostras de frames não equivalem à moderação de todos os frames.
- [x] Não criar filtro simplista por palavras políticas/sensíveis. Menção jornalística a um assunto não é, por si só, conteúdo proibido.

**Limite do contrato:** não prometer moderação do conteúdo interno das ferramentas de busca que o provedor não retorna à aplicação. Identificar esse limite na metodologia.

### Aceitação

- Conteúdo relevante após o caractere 4.000 e nas fronteiras de divisão não é omitido.
- PDF, artigo, texto e artefatos equivalentes não obtêm decisões diferentes apenas por seguirem ramos diferentes do código.
- Recusa e indisponibilidade permanecem estados distintos; nenhuma produz veredito factual.
- Falha obrigatória impede a etapa seguinte e não aciona outro provedor.
- Conteúdo permitido continua processável, inclusive reportagem contextual sobre tema sensível.

## 2. Fazer o cache respeitar a política vigente

**Áreas:** `server/cache.js`, ordem de execução e namespace em `server/verify.js`, configuração da moderação e testes de cache/endpoint.

### Implementação

- [x] Resolver a política efetiva antes de consultar um resultado elegível para entrega.
- [x] Definir fingerprint determinística da política: versão do contrato, modo e estado de produção, categorias/limiares, cobertura exigida e limites efetivos de entrada/mídia resolvidos pelas mesmas regras da aquisição. Não incluir credenciais.
- [x] Vincular essa identidade ao namespace e ao registro cacheado. Registro sem identidade compatível, inclusive legado, vira cache miss; não inferir compatibilidade por omissão.
- [x] Manter a separação existente por metodologia, configuração de IA e opções de evidência.
- [x] Em outage da leitura da época/invalidação compartilhada, ignorar o cache se não for possível provar a validade atual. HTTP de erro, JSON inválido e época vazia/inválida são fail-closed, não bootstrap; somente ausência real do objeto permite a época inicial. Não reutilizar silenciosamente época anterior.
- [x] Falha de cache deve seguir para execução normal sujeita às mesmas políticas, não contornar moderação, admissão ou orçamento.
- [x] Invalidação administrativa que não foi confirmada deve continuar retornando falha explícita; não prometer propagação para todos os nós.

### Aceitação

- Resultado criado com moderação desligada não é entregue como compatível após ativar moderação obrigatória.
- Mudança de limiar, cobertura ou limite relevante invalida a reutilização; política idêntica permite cache hit.
- Registro legado, época desconhecida e invalidação não confirmada não recuperam resultado potencialmente incompatível.
- Cache indisponível não impede análise nova quando os controles essenciais estão disponíveis.
- Nenhum teste exige reutilizar conteúdo cuja política não possa ser determinada.

## 3. Retirar a recuperação inicial em Blob da trilha crítica

**Áreas:** `server/endpoint.js`, `server/recovery.js`, contrato NDJSON e consumidor em `src/lib/api.js`, estados da interface e testes de streaming/recuperação.

### Implementação

- [x] Manter validação, autorização, limite compartilhado, capacidade e reserva de orçamento antes de inferência paga. Outage desses controles continua bloqueando.
- [x] Tratar falha de `recoveryStore.start` como indisponibilidade da recuperação, não como falha da checagem permitida. Dar à tentativa um prazo próprio limitado; não esperar indefinidamente antes do fallback.
- [x] Estender explicitamente o contrato de aceitação para informar `recoveryAvailable`. Manter um identificador da execução, mas não criar token fictício quando não houver registro recuperável.
- [x] Atualizar servidor e cliente juntos. Eventos antigos com capacidade válida continuam legíveis; ausência/invalidade de token nunca deve ser interpretada como recuperação disponível.
- [x] Sem recuperação, entregar progresso e resultado final pelo stream e informar a limitação. Não chamar `complete`/`fail` como se houvesse uma capacidade criada.
- [x] Se a conexão cair sem capacidade, não tentar GET impossível nem repetir POST pago automaticamente. Informar que a execução pode ter continuado sem resultado recuperável.
- [x] Preservar o erro primário quando a gravação de erro também falhar. Usar os diagnósticos seguros existentes, sem corpo do provedor ou segredo.
- [x] Limitar também as gravações finais: `complete` e eventual `fail` de compensação compartilham prazo total de 5 s por padrão. Falha ou espera não retém indefinidamente resultado/erro primário; recuperação indisponível fica explícita.

### Aceitação

- Blob de recuperação retorna erro ou excede prazo: análise autorizada ainda conclui, com recuperação indisponível explicitamente informada.
- Backend de orçamento/autorização indisponível: continua bloqueando; o fallback de recuperação não serve de bypass.
- Recuperação disponível mantém o comportamento anterior de um GET após perda do terminal, sem nova inferência.
- Recuperação indisponível não fabrica link/token e não dispara outra chamada paga.
- Falha de gravação posterior não substitui o resultado ou erro original.

## 4. Tornar a pesquisa adicional de artigo recuperável

**Áreas:** ramo `article-research` em `server/verify.js`, saneamento de fontes, validação final e testes de notícias inacessíveis.

### Implementação

- [x] Separar primeira avaliação válida, avaliação parcial e ausência de resultado utilizável. Guardar uma base elegível para fallback após saneamento e validação; não restaurar JSON bruto sem validação.
- [x] Encapsular a chamada adicional sem converter erro operacional em conclusão factual.
- [x] Se a pesquisa adicional falhar e existir base válida, conservar afirmações, fontes, limites e classificação dessa base, acrescentando aviso operacional separado.
- [x] Se a base for parcial, preservar apenas o que ela sustenta e a cobertura incompleta. Não atribuir nota global completa nem suavizar o texto das afirmações para confirmar mais itens.
- [x] Se não houver avaliação utilizável, devolver erro/limitação correspondente, sem fabricar checagem concluída.
- [x] Quando houver resposta adicional válida, validar evidência e conflitos antes de consolidar. Não escolher a maior nota nem ignorar evidência contrária apenas para conservar um resultado positivo.
- [x] Não acrescentar loop de retries ou troca de provedor. Controlar o tempo da etapa complementar dentro do orçamento restante de execução.

### Aceitação

- Primeira resposta válida + timeout/erro/JSON inválido na segunda: resultado elegível é preservado com aviso.
- Primeira resposta sem evidência + segunda indisponível: não há promoção a confirmado.
- Resultado adicional vazio não apaga silenciosamente afirmações já identificadas; omissões/cobertura permanecem explícitas.
- Evidência adicional conflitante ou refutadora não é descartada por conveniência.
- Fontes geradas apenas no JSON, sem proveniência da ferramenta, continuam rejeitadas em ambos os caminhos.

## 5. Tornar previsível a resolução da configuração de IA

**Áreas:** `server/ai-config.js`, resolução usada em `server/verify.js`, contrato administrativo e testes de configuração.

### Implementação

- [x] Distinguir configuração nunca definida de configuração persistida indisponível, inválida ou incompatível com o catálogo.
- [x] Usar padrões somente no bootstrap intencional sem preferência persistida, não como substituição silenciosa após outage.
- [x] Permitir reutilização somente de snapshot conhecido e válido, com os mesmos pares/revisão, origem, estado de desatualização e motivo explícitos (`config_read_failed` ou `catalog_stale`). Não rotular catálogo stale como falha de persistência. Catálogo indisponível não autoriza selecionar outro par.
- [x] Sem configuração determinável com segurança, retornar erro operacional claro antes da inferência paga.
- [x] Preservar seleção estrita ao salvar no admin e mostrar a configuração efetivamente usada em cada etapa. Não expor chaves.
- [x] Falha da chamada do modelo selecionado não provoca failover para outro modelo/provedor.
- [x] Admin distingue preferência inválida de indisponível mesmo em HTTP 200 com `config: null`: mostra `configErrors` por etapa. Inválida permite seleção explícita de opções elegíveis, sem defaults preenchidos; indisponível bloqueia edição e salvamento para não sobrescrever preferência desconhecida. Snapshot seguro é identificado como snapshot em uso.

### Aceitação

- Outage de persistência com snapshot conhecido preserva exatamente o par/revisão e informa a origem.
- Outage sem configuração conhecida não executa silenciosamente um padrão diferente.
- Bootstrap sem configuração usa o padrão documentado; configuração inválida não é confundida com bootstrap.
- Catálogo desatualizado, credencial ausente e modelo incompatível permanecem motivos distintos e observáveis.

## Verificação e liberação de cada entrega

- [x] Reproduzir o defeito com cenário controlado antes de alterar o comportamento; manter regressão para falhas, fronteiras e transições de estado relevantes.
- [x] Fazer testes determinísticos, isolados e compatíveis com a suíte inteira. Não transformar redação de prompts ou cópias de campos em testes de comportamento.
- [x] Exercitar o fluxo real ou um smoke de processo com injeção controlada da falha; testes unitários sozinhos não provam a integração. Não provocar indisponibilidade deliberada em produção.
- [x] Conferir no navegador o reparo administrativo e o bloqueio de edição na indisponibilidade, conforme smoke controlado abaixo. As demais mensagens de recuperação/cobertura não foram exercitadas neste smoke administrativo.
- A suíte, lint e build da integração final são responsabilidade do integrador; o registro histórico abaixo não comprova a revisão final.
- [x] Atualizar metodologia, configuração de exemplo e contratos públicos quando houver mudança; preservar registros históricos como históricos.
- [x] Remover scripts temporários. Publicar apenas os arquivos do escopo, mediante solicitação de commit/push.
- [ ] Validar em ambiente de pré-produção antes de ativar. Registrar versão e condições de rollback; não alegar deploy a partir de um push.

## Registro histórico de verificação anterior à revisão final

- **Suíte completa:** 383 testes aprovados, zero falhas (`node --test` sobre `server/**` e `worker/**`), incluindo as regressões novas: moderação sem corte silencioso com divisão/sobreposição e erro explícito de orçamento, PDF de entrada moderado, `.catch(() => null)` removido dos caminhos de moderação, cache vinculado ao fingerprint da política e época indisponível como miss, recuperação inicial não bloqueante com `recoveryAvailable` no `accepted`, preservação do erro primário, pesquisa adicional recuperável e configuração de IA previsível (bootstrap × outage × inválida × catálogo stale).
- **Lint:** sem erros; permanecem apenas os avisos React já existentes (10 avisos), nenhum novo aviso no servidor.
- **Build:** `vite build` concluído com sucesso.
- **Fluxo de processo:** os testes de `endpoint`/`delivery-recovery`/`client-stream` exercitam o caminho real do stream NDJSON com injeção controlada de falha do Blob de recuperação e da segunda pesquisa, sem indisponibilidade em produção.
- **Não executado neste ciclo:** deploy, pré-produção e benchmark humano — os riscos permanecem registrados abaixo.

### Smoke administrativo desta revisão — navegador real, API simulada

- Vite dev local em `127.0.0.1:5187`, componente real `Admin.jsx`, Chromium e URL `/admin?section=models`. Respostas administrativas foram simuladas no navegador com HTTP 200, `config: null`, catálogo com OpenAI/GPT-4.1 elegível para judge/visão e Whisper 1 para transcrição, sem chamar provedor.
- Com `error: ai_config_invalid` e `configErrors.judge: "Modelo persistido incompatível com busca web."`, a interface mostrou o motivo rotulado “Avaliação factual”, a explicação de bloqueio das checagens e a instrução de reparo explícito, não apenas código bruto. Seletores começaram vazios; abriu-se a opção OpenAI, depois GPT-4.1, e a seleção apareceu na linha de avaliação factual. Nenhum salvamento foi acionado.
- Com `error: ai_config_unavailable`, a interface mostrou “Edição e salvamento ficam bloqueados” e a razão para não sobrescrever a configuração desconhecida. Os seis seletores de provedor/modelo e “Salvar modelos” estavam desabilitados; recarregar/atualizar catálogo permaneceu disponível.
- Credencial fictícia restrita ao navegador; interceptação rejeitava métodos administrativos de escrita. Nenhum secret real, chamada de inferência ou gravação de configuração. Tab e serviço Vite foram encerrados. Este smoke não prova persistência, autenticação real, deploy ou precisão factual; nenhum build/lint/teste foi executado por este trabalho documental.

### Rollback seguro

- Segurança: não reabrir os desvios antigos de moderação para manter disponibilidade. Se necessário, desativar reutilização de cache ou bloquear o caminho afetado até haver versão segura.
- Recuperação/stream: servidor e cliente precisam permanecer compatíveis durante rollout e reversão; sem capacidade válida, não prometer recuperação.
- Pesquisa adicional: reverter apenas a mudança de enriquecimento, sem apagar evidência validada ou restaurar resposta bruta do modelo.
- Configuração: restaurar revisão conhecida e explícita, não iniciar seleção oculta de outro provedor.

## Fora deste ciclo, com risco ainda registrado

- Redesenho de worker, aquisição e cobertura de mídia.
- Failover automático de inferência entre provedores.
- Revisão da contabilidade: o limite efetivo auditado usa unidades; `dailyTokens` não deve ser anunciado como teto de admissão já implementado.
- Benchmark humano representativo de precisão, abstenção, fontes e decomposição. A melhora de disponibilidade não comprova melhora de precisão factual.

Esses itens continuam no inventário da auditoria; não são resolvidos pelas cinco entregas acima.
