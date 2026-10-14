# Reportes de problemas e correções

**Atualizada após implementação do plano.** As análises são automatizadas e não substituem revisão profissional, apuração ou verificação independente. Não declaramos certificação ou afiliação ao IFCN.

## O que o sistema registra

O servidor valida vínculos, status, nota e coerência do resultado, corrige automaticamente alguns campos incompatíveis e grava as correções internas no registro da checagem. Isso não equivale a revisão editorial humana, aviso ao usuário, política completa de retificação ou reanálise de históricos.

Registros antigos descrevem a execução preservada. Não são reexecutados automaticamente com `fact-check-4`; quando não têm versão de metodologia, podem aparecer como legados. Quando uma classificação é rebaixada por evidência incompatível/insuficiente, a justificativa deixa de afirmar confirmação ou refutação.

## Canal público

A página [correcoes.html](../public/correcoes.html) aceita **qualquer problema do serviço**, não só contestações factuais: erro técnico, transcrição ou leitura de mídia, download/compartilhamento, lentidão, resultado/explicação confusa, card/apresentação e outros problemas. O formulário envia para `POST /api/corrections`, reutilizando a persistência privada e a fila existente. Cada relato recebe um **protocolo** (`corr-...`) e entra na fila com estados: `received`, `in_review`, `awaiting_info`, `corrected`, `maintained`, `closed`. A consulta `GET /api/corrections?protocol=<protocolo>` devolve apenas protocolo, categoria, estado, datas, vínculo com a checagem e histórico de estados — **nunca** mensagem, contexto, contato ou notas internas.

O link **“Reportar problema ou contestar”** aparece nos resultados, inclusive sem veredito, e no diálogo de detalhes. Pré-preenche apenas o ID, quando existe, e identifica a origem (`source=result` ou `source=detail`); não leva a entrada original, transcrição nem contexto privado na URL. O formulário de checagem também oferece **“Reportar problema”** sem exigir resultado pronto (`source=app`). O card compartilhável inclui o **ID da checagem** e o endereço `correcoes.html?checkId=<ID>`; quem recebeu o card pode conferir se há correção editorial sem ver a entrada original nem os logs. A consulta por ID devolve apenas protocolos vinculados, categoria, estado e datas; um problema operacional resolvido não é anunciado como retificação factual.

Só a descrição é obrigatória (20 a 4000 caracteres). ID, contexto para reproduzir (até 1000 caracteres), link relacionado/evidência e contato são **opcionais**, também quando uma checagem falhou antes de gerar ID. Relatos de funcionamento **não exigem prova factual ou fonte**. O contexto pode conter passos, mensagem de erro, trecho relevante, horário aproximado ou navegador/aparelho, informado voluntariamente. Não coletamos automaticamente entrada original, aparelho ou histórico de navegação. O tipo também permite correção de informação, direito de resposta e remoção. Permanecem o limite de pedidos por origem, campo armadilha e validação/tetos de tamanho do backend.

No `/admin`, a seção **“Reportes e correções”** exibe categoria, prévia, estado, datas e checagem vinculada, com contagem de pedidos pendentes na amostra retida e filtros de categoria/estado. O detalhe privado inclui a descrição integral, contexto para reproduzir, origem do link, link relacionado, contato opcional e histórico de notas/estados. Não é preciso vincular uma checagem para entrar na fila ou ser revisado.

## Revisão e correção versionada

1. A fila é revisada por pessoa; a IA pode apoiar a análise, mas não decide nem altera resultado histórico.
2. Para pedidos editoriais (correção de informação, direito de resposta ou remoção), mudar o estado para `corrected` com uma checagem vinculada grava uma **correção editorial** no registro (`editorialCorrections` com protocolo, motivo, autor e data), preservando a execução original e marcando `correctedAt` na versão vigente. Para problemas operacionais, o mesmo estado significa problema resolvido **somente na fila**: não marca retificação editorial nem invalida o cache da checagem.
3. A correção editorial vinculada também **invalida o cache** (nova época em `iev-cache-v2/epoch.json`), de modo que resultados antigos deixem de ser servidos como versão vigente. Se a gravação no registro não for possível (sem Blob configurado), a resposta do painel informa o erro real em vez de fingir que a correção foi aplicada.
4. Sem armazenamento durável configurado, o endpoint público responde `503 corrections_unavailable`: não confirmamos protocolo que não foi gravado. Em desenvolvimento o registro fica em memória da instância e a resposta marca `persisted: false`.

## Limites

Uma solicitação não garante alteração automática nem prazo de resposta. Não envie senhas, tokens de acesso em links, dados sensíveis ou dados de terceiros; inclua somente o necessário para investigar. Texto e contato ficam no armazenamento privado já utilizado pela fila. O índice retém até 500 pedidos; em desenvolvimento há até 200 registros completos em memória, não duráveis. O painel descreve os modos vigentes e não apresenta a amostra retida como total histórico. Consulte [Metodologia](metodologia-factual.md) e [Privacidade](privacidade-dados-ia.md).
