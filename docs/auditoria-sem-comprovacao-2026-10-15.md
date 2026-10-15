# Auditoria de “Sem comprovação” — 15/10/2026

## Escopo e método

Consulta somente leitura ao índice administrativo e aos nove registros disponíveis naquele momento. Sete checagens tinham veredito agregado `unproven`, correspondendo a oito afirmações sem comprovação. Foram confrontados entrada, avaliação inicial (`judgeRawPreview`), fontes, citações, localização documental, revisão, validação e cache. As fontes pertinentes foram lidas manualmente; vídeos não foram autenticados nesta auditoria.

Esta é uma amostra pequena, do mesmo dia, incluindo repetições e versões históricas. Não estima precisão ou taxa geral de abstenção indevida. Nenhum registro de produção foi alterado ou republicado. Os JSONs privados e os resultados dos smoketests ficam apenas em `tmp-dl/`, ignorado pelo Git; não contêm credenciais.

## Resultados por checagem

| Registro | Afirmação/tema | Decisão manual e etapa responsável |
| --- | --- | --- |
| `97daa6b8-213d-495e-9e50-8ca7b35d7be5` | Prisão de Márcio Canella sob suspeita de lavagem de dinheiro | Abstenção indevida. A notícia documenta prisão e suspeita, sem afirmar culpa. A avaliação inicial já exigia comprovação do envolvimento criminal, além do que o claim dizia. A revisão permaneceu inconclusiva; só um dos dois trechos foi localizado e a data completa da página não acompanhou o contexto. |
| `56cf07c7-7235-40ce-94ea-7bd6be621e8b` | Autoria da fala atribuída a Tebet; maioria de Flávio versus Lula no Congresso | As duas abstenções são defensáveis com o material obtido. A autoria não foi confirmada. Declaração de Flávio sobre ter maioria não comprova coalizão/quórum assegurado nem a comparação inteira. A pesquisa original concentrou-se no post; há contexto legislativo relevante que não entrou na resposta. Não houve confirmação derrubada pelo revisor: o resultado inicial já era insuficiente e sem evidências vinculadas. |
| `c3d361fd-1de4-4e53-8f85-460c53e15b2a` | Prometer não cortar aos pobres e cortar aos ricos, mentindo para um público | Abstenção defensável para a acusação integral. Há reportagens sobre preservação de benefícios e propostas de ajuste, mas não documentam as duas falas exatas, os públicos, o mesmo objeto e a mentira deliberada. A pesquisa ficou estreita e o claim agrupou fatos atribuídos e inferência. Não cabe confirmar a acusação com notícias apenas relacionadas. |
| `361f3f6d-93bf-4158-8d24-f637b9bc022c` | “O Flávio vai fechar igreja?” | Cautela defensável: nenhuma proposta/declaração ou ocorrência identificada que estabeleça a alegação. Não transportar desmentidos sobre Lula nem confundir portas fechadas por fiéis durante uma comitiva com ordem governamental para fechar templos. |
| `0bbc0869-49b1-470b-9041-b103b02c0fad` | “Lula vai fechar igreja?” | Limitação operacional/documental, não dúvida factual nova sobre o rumor. A primeira avaliação refutou, mas AFP e UOL devolveram HTTP 403 e nenhuma citação ficou apta à revisão. A abstenção é segura para os documentos que o servidor efetivamente conseguiu ler, mas o motivo é acesso, não ausência de desmentidos. Uma checagem posterior (`98891fa7…`) localizou o Comprova/SBT e terminou refutada. Não se deve aceitar automaticamente uma fonte bloqueada. |
| `3457c7f9-7499-413a-a57f-eed792d659ce` | Lula/igrejas, versão 11 | A pergunta virou existência de anúncio/medida atual até uma data acrescentada. As fontes dão contexto, não provam inexistência universal. A abstenção é defensável para essa proposição ampliada, mas a reformulação do rumor era o problema. O commit `dd003bc` já corrige esse escopo na versão 12; não se deve apagar o histórico nem tratar o caso como nova falha da mesma versão. |
| `48037f28-c238-474f-8856-44110d017e4a` | Lula/igrejas, cache da versão 11 | Registro histórico com `status: unproven`, mas revisão/suporte `refutes`; raw da avaliação ausente. O trecho de contexto não certifica inexistência de qualquer medida. A promoção automática desse registro seria inadequada. O ajuste de resolução conclusiva de `dd003bc` e a separação do cache por versão já tratam o contrato nas novas execuções; não reconstruímos a execução original a partir deste cache. |

## Fontes confrontadas

- [Agência Brasil: prisão de Canella e operação da PF, 15/10/2026](https://agenciabrasil.ebc.com.br/geral/noticia/2026-10/pf-faz-nova-acao-contra-suspeitos-de-lavagem-de-dinheiro-em-postos). O primeiro parágrafo documenta os mandados e nomeia Canella entre os presos.
- [Comprova/SBT: falsos tuítes e rumor de fechamento de igrejas, 10/10/2022](https://sbtnews.sbt.com.br/noticia/category/226361-falso-lula-nao-disse-que-vai-fechar-igrejas-caso-seja-eleito). Desmentido fundamentado do conteúdo específico; não garantia sobre toda ação futura.
- [Agência O Globo, reproduzida na Tribuna do Sertão, 06/10/2026](https://www.tribunadosertao.com.br/poder-e-governo/2026/10/06/991911-flavio-diz-que-usara-maioria-no-senado-e-na-camara-para-mudar-a-constituicao). Registra a declaração de Flávio e diferencia bancadas, apoios necessários e quórum de PEC.
- [Poder360: promessa sobre Bolsa Família, 16/07/2026](https://www.poder360.com.br/poder-eleicoes-2026/flavio-afirma-que-nenhum-candidato-vai-cortar-o-bolsa-familia/).
- [Reuters/InfoMoney: aposentadorias e ajuste em outras despesas, 08/10/2026](https://www.infomoney.com.br/politica/flavio-promete-reajustar-aposentadoria-acima-da-inflacao/).
- [InfoMoney/Folha: plano estudado pela equipe, 08/10/2026](https://www.infomoney.com.br/politica/plano-de-ajuste-fiscal-de-flavio-bolsonaro-preve-corte-de-2-do-pib-diz-jornal/). Proposta de equipe não equivale a fala do candidato nem a execução.
- [GospelPop: controvérsia e ausência de plano apresentado no episódio, 09/10/2026](https://gospelpop.com/articles/lula-nao-feche-minha-igreja-nikolas-ana-elisa-o-que-e-fato).
- [Agência Brasil: declaração de respeito às religiões, 12/10/2026](https://agenciabrasil.ebc.com.br/politica/noticia/2026-10/lula-defende-respeito-religioes-no-dia-de-nossa-senhora-aparecida).
- [Bereia: recirculação dos boatos sobre igrejas, 09/10/2026](https://coletivobereia.com.br/lula-nao-feche-minha-igreja-mentira-antiga-volta-as-redes-impulsionada-por-nikolas-ferreira-e-perfis-do-pl/).

## Correção aplicada: `fact-check-13`

1. Avaliação inicial e revisão compartilham regra explícita de escopo: comprovar prisão/suspeita não exige comprovar crime ou condenação. Atribuição de fala/estimativa também não equivale a comprovar seu conteúdo.
2. A revisão recebe título, URL e data de publicação extraídos da página obtida, além do período alegado. Metadados são identificados como tais: ajudam a interpretar “hoje”/“nesta quinta-feira”, mas publicação não vira automaticamente data do evento. Nenhuma data é criada a partir do URL ou da data da checagem.
3. Citações com omissão editorial explícita podem ser localizadas por fragmentos ordenados e limitados. A janela enviada contém o texto intermediário real, inclusive negações e ressalvas, e não uma colagem. Fragmentos triviais, fora de ordem ou excessivamente distantes não são aceitos; não houve relaxamento do fuzzy geral.
4. A janela localizada não é truncada novamente pelo coletor de evidências: todo o intervalo necessário permanece disponível à revisão, mesmo quando maior que a janela contextual usual.
5. A nova versão separa o cache anterior. Os limiares JEV de 0,8 e diferença de 0,2, as exigências documentais e a abstenção agregada com cobertura insuficiente permanecem.

## Verificação real

Replay com JEV real e citações do registro Canella, antes da correção: classe mais provável `supports` com 0,51, convertida corretamente em `unclear` pelo limiar; prisão permaneceu `unproven`. Esse número é a saída daquela chamada, não probabilidade calibrada de verdade.

Depois da correção, nova obtenção dos dois documentos reais localizou quatro de quatro citações (antes: três de quatro). JEV retornou suporte de 0,94 para a prisão; revisão e validação terminaram com as duas afirmações confirmadas e score agregado 95. Foi replay local, não alteração do registro publicado.

Controle real com seis alegações sobre os mesmos documentos:

| Alegação | Resultado observado |
| --- | --- |
| Prisão sob suspeita em 15/10/2026 | `true` |
| Cometeu lavagem de dinheiro | `unproven` |
| Foi condenado na operação | `unproven` |
| Prisão nessa operação em 15/10/2025 | `false` |
| Movimentação de R$ 7,6 bilhões comprovada | `unproven` |
| Relatório citado apresenta suspeita de movimentação | `true` |

Os controles demonstram a distinção entre fato processual, acusação e culpa nesse conjunto, não uma taxa de precisão geral. Documentos bloqueados, pesquisa insuficiente, contexto incompleto e autenticidade de vídeos continuam limitações reais; não são resolvidos aceitando automaticamente fontes ou baixando o limiar.

Uma execução completa de `runVerify`, com a afirmação sobre a prisão enviada como texto, pesquisa web com GPT-6 Luna, obtenção documental, JEV e validação reais, retornou `checked/true`, score 95, em 17.262 ms. Obteve Agência Brasil e UOL e localizou três de três citações, inclusive uma com duas omissões editoriais. Armazenamento/cache compartilhados foram desabilitados apenas para o smoke local (`storage.persisted: false`). Não foi uma nova análise audiovisual do vídeo do X.

A página pública da metodologia foi conferida no navegador local: versão 13 e explicação de escopo visíveis, sem overflow horizontal no viewport observado. Os scripts temporários de coleta/smoke foram removidos após as execuções; os JSONs de evidência permanecem ignorados em `tmp-dl/`.

Verificação de engenharia: 266 testes aprovados com variáveis de armazenamento externo removidas somente do subprocesso de testes; lint sem erros e com dez avisos React em quatro arquivos não alterados; build concluído. A primeira execução com o ambiente herdado expôs a expectativa de armazenamento desabilitado de um teste administrativo e uma asserção nova que rejeitava indevidamente uma ocorrência válida entre âncoras repetidas. A asserção sobre esse detalhe interno foi removida, mantendo as regressões de comportamento, limites, isolamento documental e preservação de ressalvas. Não houve alteração no código administrativo ou nas credenciais/configurações persistidas.
