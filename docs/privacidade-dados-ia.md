# Privacidade e processamento de dados por IA

**Atualizada após implementação do plano.** Esta página descreve o comportamento presente no código do repositório; não é aconselhamento jurídico, declaração de conformidade ou garantia sobre práticas de terceiros. As variáveis e serviços efetivamente configurados em produção não foram inspecionados nesta entrega. Não submeta conteúdo que não esteja autorizado a compartilhar.

## Dados processados

Uma checagem pode envolver texto e URL enviados, nome e hash do arquivo, metadados, texto do post/página extraído, afirmações e evidências, consultas/citações retornadas pela busca, transcrição, OCR/descrição visual, resultado, modelo/provedor, versão metodológica, fases e dados técnicos de execução. Conteúdo submetido pode incluir dados pessoais ou sensíveis.

Uploads de imagem/vídeo enviam os bytes reais ao endpoint de checagem, com limite de 3 MiB e validação de assinatura/tipo no servidor. Imagem é enviada ao modelo de visão configurado. Extração de vídeo/áudio usa o worker, se ele estiver configurado e acessível; o worker recebe a URL ou o arquivo, processa áudio/frames e remove arquivos temporários pelo código. A transcrição é enviada ao serviço OpenAI de áudio; imagens/frames e o contexto de análise são enviados ao provedor de visão selecionado. Não há garantia de que o worker esteja disponível em cada ambiente ou de que toda mídia seja processada.

## Provedores externos

A etapa de julgamento e, para imagem/vídeo, a etapa final usam o provedor/modelo configurado no painel. A busca web é solicitada pela API correspondente. Os provedores podem receber o texto da entrada, instruções, metadados, texto extraído e contexto necessário àquela etapa; serviços de mídia também recebem conteúdo de áudio ou imagem quando usados. O endpoint de transcrição disponível é OpenAI. Não ocorre troca automática para outro provedor quando uma etapa falha; falha é registrada como operacional. Os segredos de API permanecem no servidor.

OpenCode Go aparece como opção de provedor no código, mas sua adequação ao uso com dados de usuários deve ser avaliada antes de selecioná-lo. Requisitos comerciais, retenção, uso para treinamento, região de processamento e políticas de cada provedor/modelo precisam ser verificados diretamente com o fornecedor. Não afirmamos que dados deixem de ser retidos/usados para treinamento nem que permaneçam em região específica.

## Armazenamento no serviço

- **Cache:** resultados são armazenados em memória e, quando o token de Blob está configurado, em Blob privado. O cache só serve entradas com a mesma revisão de configuração/metodologia e deixa de servir após 24 horas. O TTL não é exclusão física: objetos expirados podem continuar armazenados. A limpeza de objetos do prefixo público antigo é best-effort, não garantia de remoção completa.
- **Logs administrativos:** quando o Blob está configurado, logs e índice são gravados como privados. Podem conter previews de entrada, transcrição, prompts/respostas truncados, afirmações, fontes, configuração e fases. O índice expõe até 200 registros; a remoção de objetos excedentes ocorre apenas em condições específicas e best-effort. Não há prazo de retenção física garantido. Sem token de Blob, o código grava apenas uma linha mínima no console e a configuração/cache ficam efêmeros na instância.
- **Arquivos:** bytes brutos do upload não são colocados no log nem no cache; hash/nome podem ser registrados. Textos derivados — como transcrição, OCR e resposta — podem ser persistidos. Arquivos temporários de mídia são removidos pelo código após processamento, mas retenção de plataforma/deploy não foi verificada.
- **Configuração:** preferências de provedor/modelo são persistidas em Blob privado quando disponível. Credenciais permanecem em variáveis de ambiente server-side e não são retornadas ao navegador.

A interface mantém até 20 resultados recentes em `localStorage` do navegador, incluindo partes do resultado, claims e referências; esses dados permanecem até serem substituídos ou o armazenamento do navegador ser limpo. Se o armazenamento estiver indisponível, o histórico é apenas de sessão.

## Limites e controles

Os logs/cache não são um compromisso de retenção por prazo fixo, e a exclusão de uma checagem pode não remover imediatamente cópias, objetos antigos, dados de terceiros, logs de infraestrutura ou backups. Não foi verificada a implantação/ACL efetiva do Blob nem a política dos serviços upstream. A configuração ativa de provedor, worker, chaves, retenção e região em produção é desconhecida a partir do código-fonte.

A página [Correções](politica-correcoes.md) descreve os meios disponíveis no produto; não há nesta implementação um canal público de contato que possamos prometer. Consulte também [Metodologia factual](metodologia-factual.md).
