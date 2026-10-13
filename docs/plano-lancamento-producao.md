# Plano de preparação para produção e divulgação pública

## 1. Decisão e objetivo

**Recomendação atual: beta fechada e monitorada; divulgação ampla bloqueada até os critérios deste plano serem atendidos.** A beta também exige os controles mínimos de segurança e operação descritos abaixo: convite não substitui proteção técnica.

Objetivo: preparar a aplicação para receber tráfego público, verificar afirmações com evidências rastreáveis, controlar riscos de conteúdo/custo e permitir contestação e correção dos resultados.

Este documento é um plano. Não comprova que os controles estão implementados, que a produção está validada ou que a ferramenta tem uma taxa de precisão conhecida.

### Base conhecida

- Código atualizado para `fact-check-4`, no commit `c460ccf`, enviado para `origin/main`.
- Captura de fontes estruturadas, revisão com dossiê compartilhado, comparação de períodos conhecidos, transcrição/visão em paralelo e diagnóstico administrativo implementados.
- Cinco regressões de validação passaram; isso não é benchmark factual.
- Na investigação de `mv6y75tx-3qqrxr`, dados de pesquisas existentes não foram confirmados adequadamente. Uma execução local corrigida do mesmo reel passou a ter fontes, mas ainda não confirmou a alegação sobre rejeição e levou aproximadamente 2min05s.
- Deploy mais recente e configuração integral de produção não foram verificados.

### Documentos existentes

Este plano organiza a entrega; os documentos abaixo continuam sendo as referências específicas, evitando uma segunda metodologia:

- [Guardrails e segurança](guardrails-seguranca-plano.md).
- [Metodologia factual](metodologia-factual.md).
- [Política de correções](politica-correcoes.md).
- [Privacidade e dados](privacidade-dados-ia.md).
- [Status da implementação do admin](admin-status-implementacao.md).

## 2. Governança e sequência

### Responsabilidades

| Papel | Responsabilidade |
|---|---|
| Responsável técnico | Implementação, testes, evidência de runtime e correção de defeitos |
| Responsável por infraestrutura | Rede, worker, limites da plataforma, segredos, armazenamento e operação |
| Responsável editorial | Política factual, corpus, adjudicação, revisão e correções |
| Responsável pelo produto | Regras de uso, orçamento, comunicação e decisão de lançamento |
| Responsável por privacidade/jurídico | Tratamento de dados, conteúdo proibido e adequação dos fornecedores |

São papéis necessários, não pessoas já designadas. Uma pessoa pode acumular funções, mas as duas anotações do corpus precisam ser feitas independentemente, e sua independência deve ser real.

### Etapas de execução

1. **Definir políticas e infraestrutura:** orçamento, limites de mídia, tratamento de conteúdo, responsáveis e canal de correção.
2. **Fechar a fronteira de segurança:** SSRF, downloads, leitura de corpos, autenticação do worker e limites compartilhados.
3. **Fortalecer pesquisa/evidência:** obtenção segura de documentos, fidelidade de citações, pertinência e temporalidade.
4. **Integrar moderação, correções e comunicação pública.** A montagem do corpus e a definição editorial podem avançar desde a primeira etapa; a medição final usa a versão candidata congelada.
5. **Validar a versão candidata em staging e produção restrita.**
6. **Executar beta monitorada, medir qualidade/operação e decidir divulgação.** Mudanças após avaliação exigem revalidar os caminhos afetados.

A obtenção de páginas de evidência depende da proteção SSRF e dos limites de transferência. Segurança, políticas editoriais e montagem do corpus são frentes distintas; não devem esperar desnecessariamente umas pelas outras.

Não liberar silenciosamente uma versão com modalidades removidas para contornar um gate. Lançamento restrito a texto ou outra redução do escopo exige decisão explícita do produto e aprovação do responsável pelo lançamento, com comunicação visível.

## 3. Frente A — Qualidade factual

### Problema

A aplicação pode usar rodadas distintas, não localizar a fonte primária e dar uma classificação cuja justificativa não acompanha a evidência. Uma fonte existente não garante que o modelo a encontre ou interprete corretamente.

### Entregas

1. Especificação editorial de claims atômicos, datas relativas, tendência, causalidade, pesquisa eleitoral, opinião e abstenção, reutilizando a rubrica atual.
2. Corpus inicial de pelo menos **200 casos únicos**, com distribuição explícita por modalidade e risco: texto, notícia por link, post textual, imagem, áudio/vídeo, material insuficiente/inacessível, alegações falsas e verdadeiras, manipulação de contexto e entradas adversariais.
3. Casos de pesquisa com instituto, publicação, coleta, registro informado, população, votos totais/válidos, margem de erro, rejeição e série temporal. Incluir os casos reais que expuseram defeitos, mas não usar somente esses casos para medir qualidade.
4. Duas anotações humanas independentes e adjudicação, com links e documentos que sustentem o gabarito.
5. Separação por evento/assunto entre desenvolvimento e avaliação reservada. Congelar o conjunto reservado antes de ajustar prompts; controlar manualmente vazamento, pois o harness não faz isso.
6. Execução do harness existente, com versão metodológica, configuração de modelos, evidências, erros e abstenções. Repetir um subconjunto fixo para medir estabilidade.
7. Relatório agregado e por modalidade/categoria. Não publicar uma métrica única que esconda falha em vídeo ou um grupo de alegações.

### Gates propostos de qualidade

Estes valores são metas propostas para aprovação editorial antes da avaliação, não resultados observados nem uma certificação:

- Acordo de status factual por claim de pelo menos 90% e macro-F1 de pelo menos 0,85 no conjunto reservado.
- Pelo menos 95% das citações revisadas com trecho fiel e relação semanticamente correta.
- Nenhuma acusação falsa de alto impacto observada no conjunto de liberação; relatar intervalo de incerteza e denominador. Zero erros observados não significa risco zero.
- Nenhum resultado factual inventado nos cenários de mídia inacessível, ausência de claim e entradas proibidas da bateria de liberação.
- Cobertura e abstenção reportadas junto da precisão: abster-se de tudo não satisfaz o gate.
- Categorias sem amostra suficiente não podem ser anunciadas como validadas. Lacunas exigem ampliar a amostra ou aprovar explicitamente escopo menor.

O harness pode precisar de extensão para métricas agregadas não existentes e recortes editoriais; não inferir sua presença a partir deste plano. Mudanças na rubrica exigem versionamento e não podem ser feitas apenas para melhorar o placar do benchmark.

### Evidência de conclusão

Corpus versionado com acesso apropriado, registros de anotação/adjudicação, configuração congelada, comando de avaliação e relatório com denominadores, intervalos e falhas conhecidas. Dados sensíveis não devem ser publicados junto do relatório.

## 4. Frente B — Evidências, fontes e pesquisa

### Problema

Hoje o servidor verifica proveniência da URL, vínculo, relação e formato do trecho. Não confirma independentemente que o trecho existe nem que ele sustenta a afirmação. URLs reais podem carregar citações inventadas, traduzidas sem identificação ou fora do contexto.

### Entregas

1. Manter a rejeição de URLs somente escritas pelo modelo; preservar a origem da URL e a etapa que a obteve.
2. Criar um dossiê de documentos obtidos por acesso remoto seguro, com URL solicitada/final, status, título, publicação quando disponível, tipo de documento, instante de obtenção e referência ao conteúdo usado. Aplicar os limites de rede/retensão antes de guardar conteúdo.
3. Extrair texto de HTML/PDF e localizar os trechos com normalização controlada de espaços, entidades e hifenização. Não transformar similaridade aproximada em prova de uma citação literal.
4. Guardar trecho no idioma original. Tradução, quando exibida, deve ser identificada e manter o original rastreável; não apresentar tradução gerada como citação literal da página.
5. Distinguir fonte descoberta, documento acessado, trecho localizado e relação com claim avaliada. Ausência de trecho não é evidência de falsidade.
6. Revisar pertinência semântica: o trecho deve tratar do mesmo sujeito, indicador, local, universo e período. Revisão por modelo é defesa adicional, não prova independente nem substituto do corpus humano.
7. Para séries e pesquisas, vincular cada rodada ao documento correspondente; a rodada anterior pode dar contexto, mas não refutar automaticamente a atual.
8. Pesquisa adicional limitada às lacunas identificadas, com orçamento definido. Não repetir indefinidamente buscas nem trocar provedor silenciosamente.
9. Mostrar as limitações no resultado público e no admin: bloqueio, paywall, trecho não localizado, documento parcial, conflito e data desconhecida.
10. Definir tratamento para evidência em vídeo, imagens, tabelas e áudio. Não impor localização em texto HTML a formatos sem texto equivalente nem aprovar esses formatos por uma URL apenas; usar locator compatível e registrar a limitação de cobertura.

### Critérios de aceitação

- URL inventada, homepage genérica, fonte sem vínculo e tentativa de abertura que falhou não são promovidas a evidência validada.
- Trecho inexistente, tradução não identificada, período incompatível e fonte sobre outro tema são detectados na bateria de regressão.
- Redirecionamentos legítimos mantêm o vínculo com o documento final, sem liberar destinos inseguros.
- Fonte inacessível gera limitação ou abstenção, nunca um falso factual automático.
- Cada fonte exibida permite compreender o que foi efetivamente verificado e o que ainda depende de avaliação semântica.
- Conjuntos de fontes deduplicadas/removidas mantêm os identificadores corretos de todas as evidências restantes.

### Áreas de implementação

`server/verify.js`, `server/scoring.js`, `server/checklog.js`, `server/cache.js`, `src/lib/api.js`, `src/components/ResultCard.jsx` e abas de claims/fontes/execução em `src/components/Admin.jsx`. A implementação deve atualizar consumidores e contratos, sem aceitar o formato antigo como prova equivalente por conveniência.

## 5. Frente C — Downloads e recursos de mídia

### Problema

Upload direto é limitado a 3 MiB. Esse valor não protege o download de um vídeo remoto. Limitar áudio após conversão e usar timeout não limita, por si só, bytes transferidos ou disco consumido.

### Entregas

1. Definir limites por job para transferência total, arquivo, duração admissível, disco temporário, memória e tempo total. Valores precisam ser aprovados conforme capacidade real e custo; não apresentar números propostos como limites ativos.
2. Rejeitar tamanho conhecido acima do teto antes de completar o download, sem confiar exclusivamente no tamanho declarado.
3. Contabilizar e interromper transferência com tamanho ausente, falso ou chunked. Incluir manifests, segmentos, trilhas e tentativas do mesmo job no orçamento; cada etapa não pode reiniciar um orçamento ilimitado.
4. Aplicar limites ao worker e a todos os caminhos locais/diretos que permanecerem habilitados. Caminho que não possa cumprir o limite deve ser desabilitado explicitamente até a implementação, sem fallback menos seguro.
5. Isolar temporários por job, usar quotas e limitar subprocessos. Encerrar a árvore de processos em erro, cancelamento e timeout, respeitando o sistema operacional da execução.
6. Garantir limpeza de temporários e tratar recuperação após queda do processo/worker.
7. Controlar corpos da requisição durante a leitura; Content-Length é apenas uma indicação. Manter o limite de upload no backend e alinhar o limite de transporte com o custo do base64.
8. Rejeitar texto excedente em vez de truncá-lo silenciosamente; mostrar limites e mensagens específicas na interface.

### Critérios de aceitação

- Um servidor controlado que anuncia arquivo enorme é recusado sem baixar o corpo completo.
- Um stream sem tamanho, tamanho mentiroso e mídia segmentada são interrompidos no teto, com tolerância técnica documentada e sem consumo ilimitado.
- Falhas e cancelamentos não deixam processos/temporários ativos indefinidamente.
- O limite vale mesmo sem worker e não é contornado por fallback direto.
- Verificações de abuso usam streams/fixtures controlados; não é necessário baixar 200 GB para provar a regra.

### Áreas de implementação

`api/verify.js`, `vite.api-plugin.js`, `server/uploads.js`, `server/media.js`, `worker/server.js` e `src/components/Verifier.jsx`, além das quotas e limites da infraestrutura.

## 6. Frente D — SSRF e fronteira de rede

### Problema

O bloqueio atual de alguns endereços privados na API não cobre DNS, IPv6, redirecionamentos e destinos adicionais acessados pelo downloader.

### Entregas

1. Política única de URL para API, worker e obtenção de documentos: HTTP/HTTPS, parsing estrito, rejeição de credenciais embutidas e portas fora da política aprovada.
2. Bloquear loopback, redes privadas, link-local, multicast e destinos reservados pertinentes em IPv4/IPv6, incluindo representações mapeadas/alternativas.
3. Validar todos os endereços resolvidos e conectar ao destino validado, evitando a janela de DNS rebinding. Revalidar cada redirecionamento.
4. Limitar quantidade de redirecionamentos, resolução e tempo de conexão/leitura.
5. Tratar destinos acessados por manifests, segmentos e extractors de `yt-dlp`: a validação apenas da URL inicial é insuficiente.
6. Defesa de egress no ambiente do worker, bloqueando redes internas e serviços de metadados. Se a plataforma não permitir a política necessária, selecionar infraestrutura que permita ou usar um proxy de saída com enforcement equivalente.
7. Autenticação obrigatória do worker em produção, segredos server-side e endpoint administrativo protegido. Não lançar com autenticação opcional por ausência de variável.
8. Revisar o fluxo de login/admin e verificar que corpo de resposta, erros, logs públicos e bundle não expõem credenciais.

### Critérios de aceitação

- Bateria controlada cobre URL direta, IPv6, IPv4 mapeado, domínio resolvendo para rede interna, cadeia de redirects e DNS rebinding.
- Manifest externo tentando carregar segmento interno é bloqueado pela fronteira de rede.
- Worker e obtenção de evidências não conseguem acessar endpoints internos mesmo quando a validação da aplicação é contornada na bateria de segurança.
- HTTPS público permitido continua funcional; proteção não consiste em bloquear todos os links.
- Requisição sem autenticação não inicia trabalho no worker/admin.

## 7. Frente E — Abuso, concorrência e custo

### Problema

O rate limit atual é por instância e não representa limite global de jobs, fila ou gasto com IA.

### Decisão técnica proposta

Usar um armazenamento compartilhado com operações atômicas — por exemplo Redis gerenciado compatível com a infraestrutura — para rate limit, capacidade e reservas de orçamento. A escolha comercial fica condicionada a privacidade, disponibilidade e custo. Não usar mapas locais como substituto silencioso quando o controle compartilhado falhar.

### Entregas

1. Rate limit compartilhado por origem confiável, limite global e prevenção de spoofing de headers de IP conforme o proxy da hospedagem. IP não é identidade forte e exige política de retenção.
2. Fila finita e capacidade limitada para download, conversão, transcrição e IA; leases/reservas com recuperação de jobs interrompidos.
3. Orçamento diário/mensal e limite por checagem, com reserva atômica antes de iniciar trabalho pago e conciliação do consumo observado. Incluir custo de busca, transcrição e worker, não apenas tokens de resposta.
4. Timeouts e cancelamento propagados ao worker e aos subprocessos; identificar trabalho que o provedor não permite cancelar e registrar o custo residual.
5. Chave operacional para interromper novas checagens pagas sem derrubar páginas de transparência/correção.
6. Resposta clara para limite, fila cheia e serviço de controle indisponível. Falha desses controles deve recusar novas operações caras, não abrir acesso ilimitado.
7. Alertas de aproximação de orçamento, pico de rejeições, fila e falhas. Usar limites e responsáveis definidos, sem prometer gasto máximo absoluto quando fornecedores cobram trabalho residual.

### Critérios de aceitação

- Requisições concorrentes em duas ou mais instâncias compartilham o mesmo teto.
- Reservas simultâneas não excedem a capacidade/orçamento configurados por condição de corrida.
- Queda de job não prende capacidade para sempre nem permite gasto duplicado sem identificação.
- Limite excedido ou controle indisponível não dispara chamada paga.
- Circuito de interrupção funciona em exercício operacional e mantém o canal de correção disponível.

## 8. Frente F — Propósito e conteúdo sensível

### Problema

Prompts orientam abstenção fora de escopo, mas não há uma camada própria de moderação de conteúdo. Mídia pode ser baixada/transcrita antes de o sistema concluir que não é uma checagem.

### Entregas

1. Aprovar uma matriz de admissibilidade: checagem legítima de tema sensível, material sem claim, conteúdo proibido, uso para assédio e material que não pode ser processado/redistribuído.
2. Escolher serviço/processo real de moderação para as modalidades aceitas. Confirmar capacidades, termos, tratamento de dados e condições de falha, sem presumir suporte integral a vídeo/áudio.
3. Triagem de propósito/moderação de texto antes das etapas caras; mídia passa por acesso limitado/seguro e moderação no primeiro ponto tecnicamente viável, antes da análise factual.
4. Cobertura de moderação de vídeo explicitamente definida. Dez frames factuais não são inspeção de segurança integral; adotar serviço que cubra a política ou restringir o processamento conforme decisão explícita aprovada.
5. Estados de recusa de segurança separados de `no_verifiable_claims`, erro técnico e veredito factual, com contratos atualizados de ponta a ponta.
6. Falha do serviço de moderação não libera automaticamente conteúdo que exige inspeção. Definir comportamento seguro e mensagem de indisponibilidade.
7. Previews, logs e cards não devem reproduzir conteúdo proibido; minimizar retenção e acesso de revisão. Materiais ilegais/sensíveis exigem procedimento jurídico próprio, não uma coleção pública de fixtures.
8. Exercitar prompt injection em texto, páginas, legendas, OCR e transcrição. Não conceder ferramentas com privilégios desnecessários nem usar o material como instruções.
9. Revisar as declarações de privacidade e fornecedores antes de receber dados públicos em escala. Não assumir que termos de um serviço voltado a coding permitem qualquer uso de checagem.

### Critérios de aceitação

- Opinião/pedido fora de escopo recebe abstenção, não resposta de assistente genérico.
- Alegação verificável sobre tema sensível permitido não é recusada só por mencionar o tema.
- Conteúdo proibido não gera conclusão/card factual nem é replicado indevidamente nos logs.
- Queda da moderação segue a política aprovada.
- Casos adversariais não alteram tarefa, schema ou política de fontes na bateria de liberação; limites dos testes são publicados internamente.

## 9. Frente G — Produção, observabilidade e operação

### Entregas

1. Inventariar infraestrutura real: domínio/TLS, Vercel, worker, provedores, Blob, controle compartilhado, limites de execução e responsáveis. Conferir adequação comercial dos fornecedores.
2. Staging separado, com chaves e dados próprios; não usar credenciais de produção em testes de carga ou fixtures.
3. Smoke do commit candidato realmente implantado: texto, link de notícia, post textual do X, reel/vídeo, imagem, upload, abstenção, cancelamento, erro de provedor, login/admin, catálogo, persistência de configuração e cache.
4. Confirmar armazenamento privado, política de acesso, retenção/exclusão, minimização de dados e restauração da configuração necessária. Verificar que preview público e logs não expõem segredos ou material proibido.
5. Medir latência fim a fim e por subetapa, p50/p95 por modalidade, taxa de erro, abstenção, fontes descartadas, falha de proveniência, fila, custo e consumo de disco. Publicar números apenas depois de medir.
6. Aprovar objetivos de latência/capacidade e limites de timeout usando a carga representativa e as restrições reais da hospedagem. Não fixar uma promessa de segundos baseada em um único smoke.
7. Alertas acionáveis, responsável de plantão e procedimento de incidente: mídia, provedores, segurança, armazenamento e erro factual de alto impacto.
8. Rollback de código/configuração e invalidação compatível do cache. Não reaproveitar resultados produzidos por uma versão defeituosa apenas para recuperar velocidade.
9. Circuito para suspender processamento, revisão dos resultados afetados e aviso público quando apropriado.
10. Verificar a experiência em desktop/celular, acessibilidade do fluxo principal, mensagens de limite/recusa e transparência em resultado/card. Identificar análise automatizada, cobertura e caráter não probabilístico do score; não sugerir revisão humana que não ocorreu.

### Critérios de aceitação

- Smoke observado no domínio de produção e worker realmente usados, com evidência do commit/configuração, sem escrever segredos no relatório.
- Nenhum cenário obrigatório falha silenciosamente ou troca provedor sem configuração explícita.
- Falha/cancelamento não atribui falso factual e respeita limites de custo/processamento.
- Alertas e rollback são exercitados, não apenas descritos.
- Métricas incluem volume/amostra e diferenças de modalidade/configuração; a execução local de 2min05s não é um benchmark de produção.
- Políticas publicadas correspondem ao comportamento implantado.

## 10. Frente H — Canal de contestação e correções

### Problema

Não há canal público confirmado nem processo completo de revisão/retificação. Registros antigos não são reexecutados automaticamente e cards baixados podem circular fora do controle do site.

### Decisão de produto proposta

Um formulário próprio de contestação vinculado ao ID da checagem, com contato opcional, evidência enviada e protocolo. O canal precisa funcionar sem exigir nova checagem paga. Publicar contato alternativo somente quando realmente configurado e atendido.

### Entregas

1. Formulário público e endpoint protegido contra abuso, com limite de corpo, anexos seguros, política de dados e confirmação de recebimento real.
2. Registro privado e fila administrativa com estados: recebido, em revisão, aguardando informação, corrigido, mantido e encerrado com motivo. Definir responsáveis e regras de prioridade.
3. Revisão humana da contestação; reexecução de IA pode auxiliar, mas não substituir a decisão editorial nem alterar automaticamente o resultado histórico.
4. Histórico imutável da execução original e nova revisão vinculada, com motivo, fontes, data e responsável. Distinguir correção editorial de mudança de modelo/metodologia.
5. Página estável de resultado/ID com indicação de versão e correção. Conferir autorização e redigir dados sensíveis antes de tornar um registro público; não expor o log administrativo bruto.
6. Cards compartilháveis incluem ID/URL da versão, indicação de análise automatizada e aviso para conferir atualizações. Cards já baixados não podem ser recolhidos ou atualizados automaticamente; explicitar essa limitação.
7. Resultado corrigido não continua sendo servido como versão vigente pelo cache/histórico da aplicação. Preservar auditoria sem exibir conteúdo que precisa ser removido por segurança/privacidade.
8. Publicar política com escopo, processo e canal atendido; prazo só será anunciado depois de haver capacidade e responsável aprovados.

### Critérios de aceitação

- Contestação de uma checagem real gera protocolo e aparece na fila administrativa.
- Revisão registra decisão/motivo e mostra o estado correto ao solicitante conforme a política de acesso.
- Correção mantém vínculo com a versão original, altera a versão vigente e invalida cache afetado.
- Link do card permite verificar a atualização sem expor entrada privada ou logs.
- Usuário não recebe confirmação falsa quando o armazenamento/notificação falha.

## 11. Gates de lançamento

| Gate | Exigência | Evidência exigida |
|---|---|---|
| G0 — Políticas e fornecedores | Responsáveis, orçamento, limites e admissibilidade aprovados; fornecedores adequados | Decisões registradas e configuração sem segredos |
| G1 — Fronteira segura | SSRF, downloads, worker autenticado, corpo limitado, abuso/custo e política de moderação operantes | Cenários controlados executados na infraestrutura candidata |
| G2 — Beta fechada | G0/G1, smoke de produção restrita, avisos de experimento, canal atendido e suspensão/rollback | Verificação do domínio, atendimento e operação |
| G3 — Qualidade | Dossiê de evidências e corpus humano reservado satisfazem critérios aprovados | Relatório por modalidade/categoria, amostra e incerteza |
| G4 — Divulgação pública | G0–G3, correções versionadas, operação e comunicação coerentes | Aprovação técnica, editorial, produto e privacidade |

Qualquer falha de segurança crítica, gasto não controlado, exposição de dados, acusação factual grave indevida ou canal de correção inoperante bloqueia a divulgação. A resposta pode ser suspender processamento, corrigir e revalidar; não ocultar a falha com um selo de confiança.

## 12. Rollout e acompanhamento

1. Implantar a versão candidata com acesso restrito e controle de capacidade.
2. Executar smokes e exercícios operacionais antes de convidar usuários.
3. Abrir beta a um grupo controlado, dentro da capacidade aprovada. Avisar que resultados são experimentais e podem exigir revisão.
4. Registrar casos problemáticos, revisar manualmente os de alto impacto e incorporar defeitos ao conjunto de desenvolvimento, sem contaminar o reservado.
5. Promover à divulgação pública somente com todos os gates atendidos. Ampliar capacidade por configuração aprovada e métricas, não por remoção de limites.
6. Manter acompanhamento e reavaliação após troca de modelo/provedor, versão metodológica ou extractor de mídia. Uma avaliação anterior não certifica uma configuração nova.

## 13. Checklist de entrega

- [ ] Responsáveis técnico, infraestrutura, editorial, produto e privacidade definidos.
- [ ] Limites, orçamento, política de conteúdo e fornecedores aprovados.
- [ ] Proteção SSRF aplicada a todos os caminhos de acesso remoto.
- [ ] Downloads, disco, subprocessos, corpos e texto têm limites efetivos.
- [ ] Rate limit, fila, concorrência e reservas de custo funcionam entre instâncias.
- [ ] Moderação real e tratamento de falha exercitados em todas as modalidades aceitas.
- [ ] Evidência distingue URL descoberta, documento, trecho e suporte semântico.
- [ ] Datas, rodadas, traduções e formatos não textuais têm tratamento explícito.
- [ ] Corpus humano independente, reservado e representativo avaliado.
- [ ] Critérios de qualidade aprovados antes da medição e atendidos com incerteza reportada.
- [ ] Contestação pública, revisão e correção versionada funcionam.
- [ ] Resultado/card apontam para atualização sem expor dados privados.
- [ ] Commit candidato, infraestrutura e configuração verificados em produção.
- [ ] Métricas, alertas, interrupção e rollback exercitados.
- [ ] Documentação e comunicação pública refletem limites reais, sem promessa de precisão não medida.
- [ ] Aprovação final de divulgação registrada.

## 14. Primeiro pacote de execução

Começar pelas frentes **C, D e E**, com definição das políticas da frente **F**: limitar a entrada e o custo antes de ampliar o acesso. Em paralelo lógico, organizar o corpus da frente **A** e o processo editorial da frente **H**. Só adicionar obtenção independente de páginas da frente **B** depois da fronteira segura estar funcional.

O pacote não substitui os demais gates nem autoriza divulgação por si só. A entrega completa é a combinação de comportamento verificado, evidência editorial e capacidade operacional, não apenas build aprovado ou push para `main`.

## 15. Estado de execução (código)

Registro do que existe no repositório depois da execução deste plano. **Nenhum gate está cumprido por este documento**: a lista abaixo descreve código e testes locais, não aprovação de lançamento.

| Frente | Implementado no código | Verificação | Continua pendente |
|---|---|---|---|
| A — Qualidade factual | Harness com tabelas por modalidade/categoria, aviso de amostra pequena, `--check-split` e `--require`; `scripts/corpus-tool.mjs` (init/validate/agreement/adjudicate/split); guia em `docs/avaliacao-corpus.md` | execução do harness e do corpus-tool sobre o fixture | corpus humano (200 casos, duas anotações + adjudicação), gates aprovados e medição real |
| B — Evidências | Documento obtido por acesso seguro, texto de HTML/PDF, localização de trecho em níveis explícitos, revisão de fidelidade e rebaixamento justificado | `server/evidence.test.js` + checagem real: 3 documentos obtidos (TSE/IBC/Trading Economics), 4/6 trechos localizados, 1 claim rebaixado pela revisão | validação humana da pertinência e fidelidade em amostra representativa |
| C — Downloads e mídia | Tetos por resposta/arquivo/job, vigia de disco, duração máxima, limpeza de temporários, recusa de texto excedente | `server/media.test.js`, `server/endpoint.test.js` | limites de transporte da hospedagem e quota de disco verificados em produção |
| D — SSRF e rede | Política de URL única (API, worker, evidências), IPv4/IPv6 completos, DNS validado, conexão fixada, redirects revalidados, worker fail-closed | `server/net.test.js`, `worker/server.test.js` | firewall de egresso da plataforma que hospeda o worker |
| E — Abuso e custo | Limite de taxa por origem, vagas com lease, orçamento diário, contagem de tokens e conciliação (`IEV_TOKENS_PER_UNIT`), fail-closed sem backend | `server/limits.test.js`, `server/endpoint.test.js` | backend compartilhado configurado e exercitado em produção; valores de orçamento aprovados |
| F — Conteúdo sensível | Triagem de propósito, moderação de texto/imagens/frames/transcrição, estados `content_refused`/`moderation_uncovered`, gate de cobertura de vídeo | `server/moderation.test.js` | decisão de produto sobre cobertura de vídeo e revisão jurídica dos fornecedores |
| G — Produção e operação | `/api/health`, métricas por instância, latência p50/p95, alertas por limiar, painel de sistema, rollback documentado | `server/admin-endpoint.test.js` | smoke em produção, integração de alertas com plantão e limites de plataforma |
| H — Correções | Formulário público com protocolo, fila com estados, correção editorial versionada, invalidação de cache e card com ID + consulta pública por checagem | `server/corrections.test.js`, `server/admin-endpoint.test.js` + smoke: protocolo criado, correção aplicada e estado exibido no link do card | canal atendido com responsável, prazo e processo de revisão definidos |

O que **não** foi feito por não ser implementável por código: anotação humana, decisões de produto/jurídicas, configuração de infraestrutura e verificação em produção. Ver [status por fase](admin-status-implementacao.md) e [guardrails](guardrails-seguranca-plano.md).


## 14. Primeiro pacote de execução

Começar pelas frentes **C, D e E**, com definição das políticas da frente **F**: limitar a entrada e o custo antes de ampliar o acesso. Em paralelo lógico, organizar o corpus da frente **A** e o processo editorial da frente **H**. Só adicionar obtenção independente de páginas da frente **B** depois da fronteira segura estar funcional.

O pacote não substitui os demais gates nem autoriza divulgação por si só. A entrega completa é a combinação de comportamento verificado, evidência editorial e capacidade operacional, não apenas build aprovado ou push para `main`.
