# Plano: progresso real da checagem, imagem no compartilhamento e modelos no Admin

## Escopo e restrição

Documento de planejamento dos três pedidos do usuário. Nenhuma implementação, comando, teste, alteração de configuração, commit ou deploy faz parte desta entrega. O diagnóstico abaixo vem da leitura do código atual; não houve consulta ao catálogo de produção nesta rodada.

1. Tornar explícitos o tipo de conteúdo identificado e as etapas reais de leitura, download, transcrição e fontes.
2. Gerar o card para compartilhar imagem e texto, inclusive pelo WhatsApp quando o dispositivo permitir.
3. Explicar os modelos desabilitados no Admin e planejar elegibilidade e mensagens mais precisas.

Não inclui trocar modelos em produção, reduzir controles de segurança, eliminar revisão de evidências ou prometer redução de latência.

## 1. Progresso real e específico por modalidade

### Problema comprovado no código

- `src/lib/api.js`, em `verify`, atualiza índices locais antes e depois de um único `fetch`. Há esperas artificiais de 400/400/300/300 ms. O navegador não recebe o andamento do servidor durante a execução.
- `src/data/constants.js` mantém cinco etapas fixas e frases rotativas. Elas não comprovam que download, transcrição ou busca estejam acontecendo naquele instante.
- `api/verify.js` aguarda `handleVerifyRequest` terminar para responder JSON. `server/endpoint.js` também só devolve o envelope após `runVerify`.
- `server/verify.js` já registra fases e cobertura. Esses pontos são a base para emitir progresso, sem montar um segundo pipeline.

Trocar apenas os rótulos ou usar cronômetros para avançar etapas continuaria enganoso. A decisão é transmitir eventos da execução real.

### Interface proposta

Mostrar um resumo de conteúdo identificado e uma lista dinâmica de atividades. Não depender apenas da aba escolhida: um link pode resolver para notícia, post social, PDF, imagem, áudio ou vídeo.

| Situação confirmada pelo servidor | Texto público proposto |
| --- | --- |
| Tipo ainda não determinado | Identificando o conteúdo do link… |
| Notícia/documento textual | Texto identificado · lendo o conteúdo disponível |
| Post com anexos ainda não confirmados | Post identificado · verificando os anexos disponíveis |
| Vídeo confirmado | Vídeo identificado · preparando áudio e quadros |
| Aquisição em execução | Baixando a mídia… |
| Arquivo enviado pelo usuário | Processando o arquivo enviado… — não mostrar download |
| Áudio adquirido e transcrição iniciada | Transcrevendo o áudio… |
| Frames adquiridos e visão iniciada | Analisando os quadros disponíveis… |
| Imagem em visão | Lendo a imagem e o texto visível… |
| Julgamento com pesquisa habilitada | Investigando as afirmações e pesquisando fontes… |
| URLs sendo obtidas para o dossiê | Consultando os documentos das fontes… |
| Revisão das citações | Conferindo se os trechos sustentam as afirmações… |
| Validação final | Consolidando o resultado e seus limites… |
| Resultado reutilizado | Resultado recuperado do cache · indicar a execução original quando disponível |

Distinguir **conteúdo de entrada** de **fonte usada como evidência**. Um texto extraído ou um URL encontrado não equivale a evidência confirmada.

Estados das atividades: pendente, em andamento, concluída, não aplicável, limitada e falhou. Exemplos de limitação: áudio sem fala reconhecível, mídia inacessível, leitura parcial. Atividades paralelas permanecem simultaneamente em andamento; não reduzir o estado a um único índice linear.

Sem porcentagem inventada de download ou promessa de tempo restante. Inicialmente, mostrar estado e duração transcorrida. Porcentagem de bytes somente se o caminho real fornecer total confiável.

### Transporte e contrato propostos

Usar resposta incremental no próprio `POST /api/verify`, consumida com `fetch` e leitura de `ReadableStream`. Formato recomendado: NDJSON, um objeto por linha. Não usar `EventSource`, que não atende ao POST com corpo de upload.

Tipos de evento:

- `accepted`: identificador da execução e versão do contrato.
- `content`: modalidade identificada e cobertura conhecida, distinguindo classificação provisória de confirmada.
- `activity`: identificador da atividade, eventual atividade-pai, estado, sequência e tempo; dados públicos mínimos.
- `result`: envelope final hoje usado pelo cliente, incluindo resultado, origem, cache e ID.
- `error`: código seguro e mensagem pública; sem stderr, tokens, respostas cruas de provedores ou stack.

Cada execução possui sequência crescente e um único evento terminal. O navegador deve suportar uma linha dividida entre chunks ou múltiplas linhas no mesmo chunk. Desconexão antes de `result`/`error` não significa sucesso.

Preservar validação de entrada, limites, orçamento e reserva de vaga antes de iniciar o stream. Falhas nessa admissão mantêm HTTP 4xx/5xx, JSON e `Retry-After` quando aplicável. Após iniciar a resposta, uma falha operacional chega por evento terminal: o status HTTP já não pode ser alterado.

O cliente diferencia pelo `Content-Type` o stream admitido do JSON de erro de admissão. Migrar os adaptadores Vercel e Vite, cliente e consumidores conhecidos em conjunto; não deixar um caminho antigo simulando progresso.

### Implementação futura por área

- `server/verify.js`: callback de progresso nos pontos reais de classificação, fases, cache, extração e revisão; compartilhar os mesmos identificadores das métricas existentes.
- `server/media.js` e `worker/server.js`: eventos que não ultrapassem a observabilidade real. Enquanto `/media` responde só no fim, o servidor conhece o início/fim da aquisição conjunta, mas não o instante exato da conversão interna. Para separar download de extração com precisão, adicionar canal incremental autenticado do worker, consumido internamente pelo servidor; não publicar acesso direto do navegador ao worker.
- `server/transcribe.js`: distinguir espera por vaga de chamada ao transcritor, sem declarar transcrição antes de realmente iniciá-la.
- `server/endpoint.js`: separar admissão, execução e emissão; preservar liberação da vaga e conciliação de consumo em todos os caminhos.
- `api/verify.js` e `vite.api-plugin.js`: adaptadores de streaming com headers corretos, sem buffering do resultado inteiro. Validar o comportamento efetivo na Vercel antes da publicação geral.
- `src/lib/api.js`: parser incremental; remover esperas e avanço artificial; preservar normalização do resultado.
- `src/components/Verifier.jsx` e `src/data/constants.js`: lista dinâmica e resumo de modalidade; remover frases que afirmam atividades não observadas; manter cronômetro e estado acessível com `aria-live="polite"` sem anunciar cada atualização de relógio.

Cancelamento exige contrato explícito: fechar o cliente não deve deixar uma vaga permanentemente ocupada nem prometer interromper processos que ainda não recebem sinal de aborto. Propagar o sinal pelos caminhos suportados e limpar temporários. Não transformar timeout em resultado concluído.

### Aceitação e verificação futura

- Texto não exibe download, OCR ou transcrição.
- Upload não é apresentado como download de URL.
- Vídeo mostra aquisição e, depois, transcrição/visão somente se essas atividades ocorrerem.
- Áudio não exige nem mostra frames como etapa necessária.
- Falha de aquisição não é apresentada como erro de transcrição.
- Metadados não aparecem como transcrição concluída.
- Cache não reproduz uma animação falsa de trabalho já feito.
- Duas atividades paralelas não apagam o estado uma da outra.
- Eventos atrasados de uma checagem anterior não atualizam a execução atual.
- Resultado final, erro antes/depois dos headers, chunks divididos, desconexão e cancelamento preservam os contratos.
- Smoke futuro no navegador e na Vercel, observando eventos chegando antes do resultado; não apenas teste de callback.

## 2. Compartilhar imagem e texto pelo WhatsApp

### Problema comprovado no código

- `src/components/ResultCard.jsx` usa `https://wa.me/?text=...`: esse link leva texto, não anexa um arquivo PNG.
- `src/components/ShareDialog.jsx` já gera PNG com `renderShareCard` e pode usar `navigator.share` com um `File` quando `navigator.canShare` permite.
- Hoje existem dois percursos desconectados: WhatsApp com texto e card com compartilhamento nativo.

### Limite da plataforma

Não existe parâmetro de `wa.me` para anexar arbitrariamente um arquivo local. A Web Share API abre o seletor de aplicativos do sistema; não permite garantir que o WhatsApp seja escolhido. A presença do aplicativo e a aceitação de imagem/texto variam por sistema e navegador.

Portanto, o produto pode oferecer **card pronto para compartilhar no WhatsApp**, mas não prometer envio automático nem abertura direta com PNG em todos os dispositivos.

### Decisão de UX

Unificar a ação do resultado com o diálogo de card já existente:

1. A ação de compartilhamento abre o diálogo e começa a geração local do PNG.
2. Mostrar prévia, estado de geração e texto associado.
3. Com suporte a arquivos, oferecer **Compartilhar imagem e texto**, com instrução curta para escolher WhatsApp no seletor do aparelho.
4. Sem suporte a arquivos, oferecer **Baixar imagem**, **Copiar texto** e **Abrir WhatsApp com texto**, avisando que a imagem deve ser anexada manualmente.
5. Não anunciar que a imagem foi enviada. O usuário escolhe o aplicativo, conversa e confirma o envio.

O clique que chama `navigator.share` deve ocorrer com o PNG já pronto para preservar ativação do usuário; não gerar a imagem demoradamente dentro desse clique e arriscar perder a permissão do navegador.

Se imagem+texto não forem aceitos pelo ambiente, não degradar silenciosamente para texto sob uma promessa de imagem. Explicar a alternativa. Cancelar o seletor não é erro e não deve disparar novo envio ou abrir WhatsApp automaticamente.

### Implementação futura

- `ResultCard.jsx`: encaminhar a ação ao diálogo existente, nos resultados com e sem veredito.
- `ShareDialog.jsx`: fluxo único de preparação, prévia, compartilhamento e alternativas explícitas.
- `src/lib/shareCard.js`: reutilizar `renderShareCard` e `buildShareText`; não duplicar síntese ou desenho do card.
- Reutilizar nome de arquivo, identificação da checagem e URL de correções; preservar abstenção sem nota/selo factual.
- Revogar object URLs e descartar gerações obsoletas ao fechar/trocar resultado.
- Não adicionar upload público de cards nem armazenamento no servidor: geração local é suficiente e evita exposição adicional de dados.

### Aceitação e verificação futura

- Android/Chrome e iOS/Safari: verificar em aparelhos com WhatsApp instalado que o PNG é oferecido pelo seletor e se texto acompanha o arquivo. Não declarar compatibilidade baseada só em mocks.
- Desktop/ambiente sem Web Share de arquivos: prévia e download funcionam; link WhatsApp é explicitamente só texto.
- Falha na geração, compartilhamento negado e cancelamento têm estados distintos.
- Resultado sem veredito gera imagem coerente sem `null/100`.
- Troca de resultado não compartilha o PNG anterior.
- No dia da implementação, conferir documentação vigente de Web Share e WhatsApp; limitações atuais devem ficar claras na interface e no README.

## 3. Modelos quase todos desabilitados no Admin

### Explicação baseada no código atual

**Modelo listado pelo provedor não significa modelo integrado ao pipeline.** A descoberta traz inventário; a aplicação calcula `eligibleSteps` separadamente e o Admin desabilita opções que não incluem a etapa selecionada.

Pontos concretos:

- `server/ai-config.js`, `GO_RESPONSES`: apenas seis IDs do OpenCode Go são aceitos no adapter Responses atual. Outros IDs descobertos ficam com `protocol: "unknown"` e sem etapas elegíveis.
- `isOpenAiResponsesModel`: elegibilidade da OpenAI usa uma expressão regular restritiva, não uma declaração de capacidades do inventário. IDs/sufixos fora do padrão são recusados mesmo que possam ser compatíveis.
- Há um erro específico nessa expressão: `4\.(?:1|o)` reconhece `gpt-4.1` ou `gpt-4.o`, mas **não `gpt-4o`**. Isso demonstra um falso negativo de nomenclatura, sem provar por si só todas as capacidades de qualquer variante descoberta.
- `OPENAI_TRANSCRIPTION`: os modelos aceitos de transcrição só são elegíveis em `transcribe`, não em julgamento, conclusão ou visão. Essa separação é intencional.
- Modelos Responses aceitos recebem capacidades inferidas no código. A classificação de visão também depende do provedor/nome. Não há prova individual, nesta leitura, de que todos os aceitos suportem imagem e busca nesse produto/endpoint.
- `src/components/Admin.jsx`: o seletor mostra os modelos do provedor, inclusive incompatíveis, mas resume o motivo como “incompatível com esta etapa”. O inventário detalhado mostra mais informações; isso torna a seleção pouco esclarecedora.
- `validateConfig`: além de elegibilidade, exige credencial do provedor e presença do modelo no inventário.

Logo, os desabilitados podem ser modelos de outra função, compatibilidade ainda não implementada/validada ou falsos negativos das regras de nomes. **Não significa automaticamente que estão fora do ar, sem saldo ou bloqueados pelo provedor.** Sem consultar o catálogo/configuração reais, não é possível quantificar qual motivo domina no Admin de produção.

### Decisão

Não habilitar todos os IDs e esperar falharem durante a checagem. Separar três questões:

1. **Descoberta:** o provedor listou o ID e o inventário está atualizado?
2. **Integração:** existe adapter para o protocolo e capacidades necessárias à etapa?
3. **Disponibilidade:** há credencial e houve acesso confirmado? Permissão de listar modelos não prova permissão de inferência.

### Plano de correção e visibilidade

- Substituir inferência ampla por nome por registro explícito, centralizado e auditável de protocolos/capacidades suportados, compartilhado por catálogo e resolução de endpoint.
- Corrigir a família `gpt-4o` somente com capacidades documentadas para cada variante e endpoint; não apenas ampliar regex indiscriminadamente.
- Registrar motivos estruturados: outra etapa, adapter ausente, capacidade não validada, credencial ausente, modelo fora do inventário e inventário desatualizado. Preservar a diferença entre indisponibilidade e ausência de validação.
- No seletor, priorizar modelos elegíveis; oferecer visualização dos demais com o motivo específico, sem tornar a lista principal um bloco de opções cinzas indistintas.
- Mostrar matriz por modelo: julgamento, conclusão, visão e transcrição; protocolo e estado da validação. Não exibir segredos.
- Na futura investigação, obter catálogo real por provedor e etapa e comparar com as regras locais. Nenhum inventário real foi consultado para este documento.
- Para ampliar suporte, confirmar documentação do produto específico e executar sondas pequenas e explícitas do protocolo/capacidades. Atualizar catálogo não deve disparar inferência paga em todos os modelos automaticamente.
- Configuração incompatível continua sendo recusada no servidor, não só desabilitada na interface. Falha operacional não pode provocar troca silenciosa de provedor.

### Aceitação e verificação futura

- Todo modelo não selecionável tem motivo específico visível, sem depender de tooltip inacessível.
- Modelo de transcrição não é oferecido para julgamento ou visão.
- ID compatível não é recusado apenas por um erro de grafia na regra de nomes.
- ID desconhecido não ganha busca/visão automaticamente pela semelhança do nome.
- Inventário desatualizado e credencial ausente não se confundem com incompatibilidade funcional.
- Mudanças de seleção são validadas no backend, persistidas e refletidas na revisão de configuração/cache.
- Testes futuros verificam elegibilidade, precedência de motivos e rejeição de configurações; não fixam textos de rótulos.
- Smoke futuro no Admin com catálogo real e motivos conferidos por etapa, sem expor chaves em prints ou logs.

## Sequência de execução futura

1. Mapear consumidores do endpoint e referências de APIs exportadas; definir eventos e estados públicos. Conferir suporte efetivo de streaming do ambiente implantado.
2. Implementar progresso ponta a ponta, incluindo observabilidade do worker onde for necessário distinguir download e extração. Migrar cliente/adaptadores sem simulação temporal.
3. Unificar compartilhamento utilizando o renderer e diálogo existentes; validar aparelhos e alternativas.
4. Conferir catálogo real e corrigir regras de elegibilidade; melhorar motivos e apresentação do Admin sem alterar modelos ativos por conta própria.
5. Executar verificações comportamentais, smoke das superfícies reais e regressões afetadas; atualizar documentação existente.
6. Publicar servidor e worker compatíveis juntos, quando a implementação for autorizada; confirmar eventos incrementais em produção e registrar limites encontrados.

A leitura do catálogo pode ocorrer antes da implementação para orientar a terceira frente. As três frentes têm áreas majoritariamente distintas, mas compartilham componentes de resultado e contratos públicos; a integração deve ter um responsável.

## Entregáveis esperados quando houver autorização de implementação

- Progresso fiel por modalidade/atividade, sem avanço artificial nem mensagens de trabalho não realizado.
- Card preparado para compartilhar imagem e texto, com limite do WhatsApp e alternativa manual explícitos.
- Admin com elegibilidade confiável e motivos claros; explicação dos modelos efetivamente desabilitados baseada no catálogo real.
- Evidências de verificação e publicação, sem confundir testes controlados com garantia de compatibilidade ou precisão factual.

**Estado desta entrega: implementado em 2026-10-13.** Progresso NDJSON ponta a ponta (`accepted`/`content`/`activity`/`result`/`error`), compartilhamento unificado no diálogo de card e elegibilidade por registro explícito com motivos estruturados. Verificado por `npm test` (120/120), `npm run lint`, `npm run build`, smoke NDJSON (eventos antes do resultado, admissão JSON 4xx, erro pós-início como evento terminal, split-chunk) e smoke de navegador (progresso real, resultado factual, card, Admin com catálogo real: OpenCode Go 38 IDs/6 elegíveis, OpenAI 139 IDs/5 Responses + 3 transcrição). Não verificado: streaming efetivo na Vercel em produção nem Web Share com WhatsApp em aparelho físico — ambos exigem ambiente real antes da divulgação.
