# Guardrails da aplicação: estado atual e plano de melhorias

## 1. Objetivo e escopo

Registrar as proteções existentes e as lacunas para texto, links, uploads e processamento de mídia, incluindo entradas fora do propósito de verificar fatos, conteúdo sensível, prompt injection, SSRF e abuso de recursos.

Este documento é um diagnóstico e plano; a seção 1.1 registra o que foi implementado depois. A inspeção foi feita no código local; não houve teste com conteúdo sensível nem download de arquivo gigante em produção.

## 1.1 Estado de implementação (após execução do plano)

Esta seção registra o que passou a existir no código depois do diagnóstico acima. As lacunas descritas nas seções 2 a 9 continuam sendo o histórico da inspeção; onde há conflito, vale o que está aqui.

| Área | Estado | Onde | Como foi verificado |
|---|---|---|---|
| Política de URL (SSRF) | Implementado: HTTP/HTTPS, sem credenciais, portas permitidas, IPv4/IPv6 internos (mapeados, NAT64, 6to4, Teredo), DNS com todos os endereços validados, conexão fixada no endereço validado e revalidação de cada redirect | `server/net.js` | `server/net.test.js` (matriz de endereços, redirect para metadados, timeout, tetos) |
| Worker | Implementado: recusa iniciar sem `WORKER_SECRET`, valida URL com a mesma política, concorrência limitada, vigia de disco e limpeza de temporários; usa o processador de arquivo compartilhado com o servidor | `worker/server.js`, `server/local-media.js` | `worker/server.test.js` com uploads audiovisuais reais |
| Tetos de download | Implementado: bytes por resposta, por arquivo, por job e por diretório, com interrupção da árvore de processos (`yt-dlp`/`ffmpeg`) | `server/proc.js`, `server/media.js` | `server/media.test.js` (teto, redirect, concorrência e diretórios exclusivos) |
| Processamento audiovisual local/remoto | Implementado no código: sem worker, desenvolvimento usa `ffprobe`/`ffmpeg`; serverless sem worker recusa; worker configurado não tem fallback local silencioso. Duração positiva/finita e trilhas legíveis são exigidas antes da conversão. | `server/local-media.js`, `server/media.js`, `worker/server.js` | `server/media.test.js` e `worker/server.test.js` com fixtures reais; deploy remoto de produção não foi exercitado |
| Texto excedente | Implementado: recusa com `text_too_long` (não trunca) e contador na interface | `server/uploads.js`, `src/components/Verifier.jsx` | `server/endpoint.test.js` |
| Fora de escopo | Implementado: triagem determinística recusa pedidos claros de tarefa antes do julgamento factual; números, links e comprimento incidental não os isentam, enquanto alegações, perguntas factuais e checagens identificáveis continuam elegíveis | `server/moderation.js` | `server/moderation.test.js`, `server/endpoint.test.js` |
| Moderação de conteúdo | Implementado: texto enviado, texto trazido da página/post, imagens/frames e transcrição antes das etapas caras; recusa restrita a categorias que não podem ser processadas; falha em `required` interrompe como erro operacional (503), nunca como recusa de conteúdo | `server/moderation.js`, `server/verify.js` | `server/moderation.test.js`, `server/endpoint.test.js` |
| Cobertura de vídeo | Implementado: `MEDIA_VIDEO_MODERATION` precisa ser declarado em produção; sem isso o vídeo é recusado (`moderation_uncovered`) | `server/moderation.js` | `server/moderation.test.js` |
| Abuso e custo | Implementado: limite de taxa por origem, vagas com lease, orçamento diário em unidades e contagem de tokens em backend REST compatível com Redis; produção sem backend recusa (fail-closed) | `server/limits.js`, `server/endpoint.js` | `server/limits.test.js`, `server/endpoint.test.js` |
| Corpo da requisição | Implementado: teto no adaptador HTTP e recusa durante a leitura (Content-Length é só indicação) | `api/verify.js`, `api/corrections.js`, `worker/server.js` | `worker/server.test.js` |
| Prompt injection | Mantido: material não confiável delimitado, contrato validado no servidor; nenhuma ferramenta nova com privilégio | `server/verify.js`, `server/scoring.js` | revisão de código (sem bateria adversarial completa) |
| Evidências | Implementado: documento obtido por acesso seguro, texto de HTML/PDF, localização do trecho e revisão de fidelidade com rebaixamento justificado | `server/evidence.js` | `server/evidence.test.js` |
| Correções | Implementado: canal público com protocolo, fila com estados, correção editorial versionada e invalidação de cache | `server/corrections.js`, `server/cache.js` | `server/corrections.test.js`, `server/admin-endpoint.test.js` |
| Observabilidade | Implementado: contadores por instância, latência p50/p95, alertas por limiar, `/api/health` e painel de métricas | `server/metrics.js`, `server/health-endpoint.js` | `server/admin-endpoint.test.js` |

**Ainda depende de decisão ou infraestrutura (não implementado por código):** firewall de egresso da plataforma que hospeda o worker (o código valida e oferece `WORKER_EGRESS_PROXY`, mas a barreira de rede é do provedor), limites de transporte da hospedagem, backend compartilhado de limites configurado em produção, corpus humano anotado, decisão de produto sobre cobertura de vídeo e revisão jurídica de provedores. Consulte [plano-lancamento-producao.md](plano-lancamento-producao.md).



## 2. Estado atual (diagnóstico original)

| Área | Proteção existente | Limitação |
|---|---|---|
| Texto puro | Normalização no backend limita a 8.000 caracteres | O excedente é cortado silenciosamente, não rejeitado |
| Conteúdo fora de escopo | Prompts orientam abstenção quando não há afirmação factual verificável | Depende do modelo e pode ocorrer somente depois das etapas caras |
| Prompt injection | Texto, metadados, OCR, transcrição e páginas são tratados pelos prompts como material não confiável, nunca instruções | Instrução no prompt reduz o risco, mas não comprova imunidade |
| Upload direto | Limite de 3 MiB (3.145.728 bytes), anunciado na interface como 3 MB | Não é limite para mídia acessada por URL |
| Formato de upload | Validação de base64, assinatura dos bytes, MIME declarado e compatibilidade com o tipo de entrada | Não modera o conteúdo nem comprova que toda a mídia é segura para decodificação |
| Corpo da requisição | API verifica Content-Length acima de 4.300.000 bytes; worker tem leitura limitada do corpo | A verificação de Content-Length da API não é, sozinha, um teto independente para toda leitura do corpo |
| Links internos | API bloqueia alguns IPs privados e nomes como localhost, .local, .internal e .lan | Não cobre resolução DNS, todos os endereços IPv6 e redirecionamentos em todas as etapas |
| Worker de links | Exige prefixo HTTP(S) e possui mecanismo de autenticação | Validação de esquema não substitui proteção SSRF; configuração de autenticação em produção não foi auditada |
| Rate limit | 20 checagens por IP em 10 minutos, em memória por instância | Não é global, persistente ou suficiente para abuso distribuído |
| Processamento remoto | Timeouts nos subprocessos e chamadas HTTP | Tempo máximo não equivale a limite rígido de bytes ou disco |
| Áudio resultante | Worker verifica limite de 20 MiB; transcrição verifica 25 MiB | A verificação do worker acontece depois do download/conversão |
| Frames | Até 10 frames, orçamento de 2.500.000 bytes e amostragem nos primeiros 300 segundos | Não limita necessariamente o download original a 300 segundos |

### Referências no código

- `api/verify.js`: validação da requisição, bloqueio parcial de URLs privadas e rate limit.
- `server/uploads.js`: normalização, truncamento de texto e validação de uploads.
- `src/components/Verifier.jsx`: limite de arquivo na interface.
- `server/scoring.js`: instruções contra prompt injection e resultados de abstenção.
- `server/media.js`: integração com worker, download local e limites de artefatos.
- `server/transcribe.js`: limite de áudio, timeout e controle local de processamento.
- `worker/server.js`: leitura do corpo, download, conversão e extração de frames.

## 3. Conteúdo fora do propósito de checagem

A aplicação deve separar três situações:

1. **Sem afirmação verificável:** opinião, entretenimento, previsão ou pedido de tarefa não relacionado à checagem. Resultado esperado: `no_verifiable_claims`, sem score e sem veredito factual.
2. **Material insuficiente ou inacessível:** ausência de conteúdo necessário, falha de leitura ou cobertura insuficiente. Resultado esperado: `insufficient_input` ou `inaccessible_media`, sem score e sem veredito factual.
3. **Conteúdo proibido pela política do produto:** precisa de tratamento próprio de segurança, não de um selo verdadeiro/falso.

Há uma triagem determinística antes do julgamento factual, sem chamada adicional de IA: pedidos claros de tarefa (por exemplo, resolver uma conta, resumir ou traduzir) são recusados independentemente de números, links ou comprimento. Alegações numéricas, perguntas factuais e pedidos de checagem com alegação identificável permanecem elegíveis; texto de terceiros entre aspas não é tratado como comando. A frase ambígua “me diga se é verdade” não basta, por si só, para recusar.

Essa decisão de propósito é distinta da moderação de conteúdo. Linguagem ofensiva ou tema sensível não implica ausência de fato verificável: uma afirmação sobre violência, por exemplo, pode ser legítima para checagem.

## 4. Mídia estranha, sensível ou abusiva

Não foi identificada uma camada própria de moderação de conteúdo antes de transcrição/análise da mídia.

O conteúdo pode ser processado antes de a IA concluir que não há afirmação verificável. As políticas do provedor não devem ser apresentadas como um bloqueio garantido da aplicação.

### Mudanças propostas

- Definir política do produto para nudez, violência extrema, conteúdo ilegal e outras categorias de risco.
- Separar recusa por segurança, ausência de afirmação verificável e falha operacional.
- Aplicar triagem de propósito e moderação nas etapas em que forem tecnicamente possíveis, antes das operações caras sempre que possível.
- Explicitar que moderação de amostras de vídeo não garante cobertura de todos os frames.
- Evitar replicar material sensível em previews, logs, cards compartilháveis e mensagens de erro.
- Documentar o que é enviado a cada provedor e o tratamento de dados derivados.

## 5. Arquivos gigantes: upload versus link

### Upload direto de 200 GB

O limite da aplicação é 3 MiB. A interface rejeita arquivos acima desse tamanho e o backend valida o tamanho dos bytes recebidos. Não é necessário nem adequado enviar um arquivo de 200 GB para testar essa regra.

A proteção de transporte também precisa ser garantida: validar depois de receber o corpo não elimina o custo de receber uma requisição excessiva. O limite efetivo da plataforma de hospedagem deve ser conferido separadamente.

### Link para vídeo de 200 GB

Existe uma lacuna: os comandos de download remoto inspecionados não têm um teto explícito de bytes para a mídia original. O limite do áudio resultante é aplicado depois do download/conversão.

Timeouts e seleção de baixa resolução reduzem consumo, mas não garantem recusa antes de consumir rede e disco. Extrair frames dos primeiros 300 segundos também não implica baixar apenas esse trecho.

### Mudanças propostas

- Definir limites explícitos de bytes transferidos, disco temporário, duração admissível e tempo total de processamento.
- Consultar metadados antes do download quando disponíveis, sem confiar exclusivamente no tamanho declarado.
- Interromper a transferência ao atingir o teto, inclusive quando o tamanho é desconhecido ou incorreto.
- Aplicar os limites nos caminhos do worker e de download local.
- Garantir encerramento de subprocessos e limpeza de temporários em sucesso, erro, timeout e cancelamento.
- Retornar motivo claro de recusa sem transformar falha técnica em veredito factual.

## 6. SSRF e segurança de links

O bloqueio atual na API é parcial. O worker valida o prefixo HTTP(S), mas isso não protege contra domínio público resolvendo para rede privada ou redirecionamento para destino interno.

### Mudanças propostas

- Usar parsing estrito de URL e aceitar apenas HTTP/HTTPS nos caminhos de acesso remoto.
- Validar IPv4 e IPv6, incluindo loopback, redes privadas, link-local e endereços reservados pertinentes.
- Validar os IPs retornados pelo DNS e cada destino de redirecionamento.
- Tratar DNS rebinding: a conexão efetiva não pode ignorar o destino validado.
- Aplicar a proteção no worker, não apenas na API pública.
- Restringir egress de rede do worker como defesa adicional, inclusive acesso a serviços de metadados.
- Considerar destinos adicionais acessados pelo downloader, como manifests e segmentos, ao definir a barreira de rede.

## 7. Prompt injection e integridade da checagem

Os prompts orientam a não executar instruções presentes em texto, OCR, transcrição, metadados e páginas. Isso é uma defesa existente, não uma garantia absoluta.

### Mudanças propostas

- Manter separação entre instruções da aplicação e material fornecido pelo usuário ou por fontes externas.
- Manter validação server-side do contrato de saída e da coerência de score/veredito.
- Exercitar ataques em texto, páginas, legendas, OCR e transcrição.
- Verificar que o material não altera tarefa, schema, política de fontes ou resultado por instrução embutida.
- Não adicionar ações ou ferramentas com privilégios desnecessários ao pipeline de checagem.

## 8. Abuso, concorrência e custo

O rate limit atual é local a cada instância. Ele não impede que múltiplas instâncias aceitem carga acima do limite esperado, nem representa um orçamento global de IA e processamento.

### Mudanças propostas

- Rate limit compartilhado entre instâncias.
- Validar a origem confiável do IP conforme a infraestrutura de proxy utilizada.
- Limites globais de concorrência para download, conversão, visão e transcrição.
- Fila com capacidade finita e rejeição explícita quando saturada.
- Orçamento de consumo e mecanismos de interrupção para evitar gasto ilimitado com provedores.
- Garantir que timeout/cancelamento interrompam o trabalho subjacente, não somente a espera da resposta.

## 9. Texto e mensagens ao usuário

### Mudanças propostas

- Rejeitar texto acima de 8.000 caracteres em vez de truncá-lo silenciosamente.
- Mostrar o limite e a contagem na interface.
- Distinguir mensagens para arquivo grande, formato inválido, mídia remota acima do limite, conteúdo fora de escopo, recusa de segurança e falha operacional.
- Não atribuir falso, verdadeiro ou score quando o sistema não conseguiu analisar o material.

## 10. Ordem recomendada de execução

| Prioridade | Entrega | Motivo |
|---|---|---|
| P0 | Teto real de download remoto e disco temporário | Evitar consumo descontrolado por links de mídia gigantes |
| P0 | SSRF no worker e API, com defesa de rede | Evitar acesso a destinos internos por URL, DNS ou redirecionamento |
| P1 | Rate limit compartilhado, concorrência e orçamento | Controlar abuso distribuído e custo |
| P1 | Política e triagem de propósito/moderação | Separar checagem legítima de uso indevido e conteúdo proibido |
| P2 | Rejeição explícita de texto excedente e mensagens claras | Evitar análise silenciosamente incompleta |
| P2 | Exercícios de prompt injection e revisão de privacidade | Verificar comportamento adversarial e exposição de conteúdo |

Os valores novos de download, duração, fila e orçamento devem ser definidos na implementação com base na infraestrutura e no custo admissível. Este documento não estabelece valores não existentes como se já estivessem ativos.

**Execução:** os itens P0, P1 e P2 acima foram implementados no código (ver seção 1.1). O que permanece fora do código é infraestrutura e decisão: firewall de egresso da plataforma, backend compartilhado configurado em produção, limites de transporte da hospedagem, corpus humano e revisão jurídica dos provedores.

## 11. Critérios de aceitação

### Texto e escopo

- Texto no limite é aceito; acima do limite recebe erro claro, sem corte silencioso.
- Pedido fora da tarefa não produz resposta de assistente genérico nem veredito factual inventado.
- Material sem afirmação verificável recebe abstenção explícita.
- Instruções embutidas no material não alteram o contrato de saída ou a tarefa.

### Upload

- Arquivo acima do limite é recusado no frontend e no backend.
- MIME incompatível, assinatura inválida e base64 inválido são recusados.
- A camada de transporte interrompe corpo excessivo sem depender apenas de Content-Length.

### Links e mídia remota

- Tamanho conhecido acima do teto é recusado antes do download completo.
- Tamanho ausente ou incorreto continua sujeito a limite durante a transferência.
- Limites funcionam no worker e no caminho local.
- Destinos internos são bloqueados por IP, DNS, IPv6 e redirecionamento.
- Saturação, timeout e cancelamento não deixam trabalho ou arquivos temporários órfãos.

### Moderação e abuso

- Categorias proibidas têm política e resposta explícitas, distintas de veredito factual.
- Falha do moderador tem tratamento definido; não existe promessa de moderação sem execução.
- Múltiplas instâncias compartilham o mesmo limite de abuso.
- Fila e concorrência não crescem indefinidamente.
- Previews, logs e cards não reproduzem conteúdo proibido por acidente.

## 12. Evidência da inspeção

Smoke local original, executado com `normalizeVerifyInput`:

| Cenário | Resultado observado (diagnóstico) |
|---|---|
| Texto com 9.000 caracteres | Normalizado para 8.000 caracteres |
| Buffer de upload com 3.145.729 bytes | HTTP status associado 413, `upload_too_large` |
| Bytes não correspondentes a imagem, declarados como PNG | HTTP status associado 415, `unsupported_upload_type` |

Esses resultados exercitam a normalização local. Não comprovam moderação, segurança integral contra SSRF, limite de download remoto ou comportamento da infraestrutura de produção.

### Evidência atual (após implementação)

Rodar `npm test` cobre, com servidores locais controlados e sem depender de rede externa:

| Cenário | Teste |
|---|---|
| Endereços internos (IPv4, IPv6, mapeados, NAT64, 6to4) e política de porta/host | `server/net.test.js` |
| Redirect para serviço de metadados bloqueado; tamanho declarado e real acima do teto; timeout; orçamento de bytes | `server/net.test.js` |
| Arquivo remoto acima do teto recusado; destino interno bloqueado; frames do worker filtrados | `server/media.test.js` |
| Worker sem `Authorization`, URL interna, corpo acima do limite, upload fora do contrato | `worker/server.test.js` |
| Rate limit, vagas com lease, orçamento diário e fail-closed sem backend | `server/limits.test.js` |
| Endpoint: 503 sem controles, 429 por taxa/capacidade/orçamento, URL interna, abstenção de pedido ao assistente | `server/endpoint.test.js` |
| Recusa por categoria proibida, falha do moderador em `required`, cobertura de vídeo | `server/moderation.test.js` |
| Texto de HTML/PDF, localização de trecho e rebaixamento por fidelidade | `server/evidence.test.js` |
| Protocolo de correção, modo fail-closed e visão pública sem contato | `server/corrections.test.js` |
| Autenticação do admin, métricas, fila de correções e invalidação de cache | `server/admin-endpoint.test.js` |

O que **não** está coberto por esses testes: bateria adversarial completa de prompt injection, comportamento da rede real da hospedagem, limites de transporte da plataforma, precisão factual (exige corpus humano) e moderação de vídeo integral.
