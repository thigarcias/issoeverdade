# Correções

**Atualizada após implementação do plano.** As análises são automatizadas e não substituem revisão profissional, apuração ou verificação independente. Não declaramos certificação ou afiliação ao IFCN.

## O que o sistema registra

O servidor valida vínculos, status, nota e coerência do resultado, corrige automaticamente alguns campos incompatíveis e grava as correções internas no registro da checagem. Se uma correção alterar claim, score, veredito ou fonte, o resumo pode ser substituído por um aviso genérico para não manter uma síntese contraditória. Isso não equivale a revisão editorial humana, aviso ao usuário, política completa de retificação ou reanálise de históricos.

Registros antigos descrevem a execução preservada. Não são reexecutados automaticamente com `fact-check-4`; quando não têm versão de metodologia, podem aparecer como legados. Quando uma classificação é rebaixada por evidência incompatível/insuficiente, a justificativa deixa de afirmar confirmação ou refutação.

## Canal público

A página [correcoes.html](../public/correcoes.html) tem formulário próprio que envia o pedido para `POST /api/corrections`. Cada pedido recebe um **protocolo** (`corr-...`) e entra numa fila privada com estados: `received`, `in_review`, `awaiting_info`, `corrected`, `maintained`, `closed`. O estado pode ser consultado em `GET /api/corrections?protocol=<protocolo>`, que devolve apenas protocolo, estado, datas, vínculo com a checagem e o histórico de estados — **nunca** o contato nem as notas internas.

O card compartilhável inclui o **ID da checagem** e o endereço `correcoes.html?checkId=<ID>`; quem recebeu o card pode conferir, sem ver a entrada original nem os logs, se aquele resultado já foi corrigido. A consulta `GET /api/corrections?checkId=<ID>` devolve apenas protocolos vinculados, estado e data da correção editorial (quando houver).

O formulário aceita: ID da checagem (opcional, pré-preenchido pelo link "Contestar este resultado" do card), tipo do pedido (correção, direito de resposta, remoção), mensagem obrigatória (20 a 4000 caracteres), link de evidência (opcional) e contato para retorno (opcional). Há limite de pedidos por origem e um campo armadilha contra envio automatizado.

## Revisão e correção versionada

1. A fila é revisada por pessoa; a IA pode apoiar a análise, mas não decide nem altera resultado histórico.
2. Mudar o estado para `corrected` grava uma **correção editorial** no registro da checagem (`editorialCorrections` com protocolo, motivo, autor e data), preservando a execução original e marcando `correctedAt` na versão vigente.
3. A mesma ação **invalida o cache** (nova época em `iev-cache-v2/epoch.json`), de modo que resultados antigos deixem de ser servidos como versão vigente. Se a gravação no registro não for possível (sem Blob configurado), a resposta do painel informa o erro real em vez de fingir que a correção foi aplicada.
4. Sem armazenamento durável configurado, o endpoint público responde `503 corrections_unavailable`: não confirmamos protocolo que não foi gravado. Em desenvolvimento o registro fica em memória da instância e a resposta marca `persisted: false`.

## Limites

Uma solicitação não garante alteração automática nem prazo de resposta. O canal atende pedidos sobre resultados identificáveis (com ID); pedidos genéricos são revisados conforme a capacidade da operação. Consulte [Metodologia](metodologia-factual.md) e [Privacidade](privacidade-dados-ia.md).
