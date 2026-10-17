# Audiência e links publicados

Em **Admin → Métricas → Audiência & links**, o painel mostra acessos, visitantes estimados, aberturas de links publicados, distribuição por estado/região, origem, evolução diária e ranking de todos os links publicados (incluindo os que ainda têm zero acessos). Um clique no título do ranking detalha aquele link; origem, estado, região e período continuam filtrando os gráficos.

Filtros: hoje, últimos 7/30/90 dias ou intervalo personalizado de até 90 dias, sempre no horário de Brasília. Os filtros de provedor/modelo continuam na área separada **Operação & IA**. O ranking tem busca e paginação; no celular, cada linha vira um cartão. O gráfico tem uma tabela acessível com os valores por dia.

## Contagem

- Uma página visível, aberta pelo navegador, envia `page_view`. Um resultado compartilhado só conta depois de ser carregado com sucesso. Recarregar gera novo acesso; efeitos duplicados e retries técnicos no mesmo documento não geram outro evento.
- IDs privados e inexistentes não recebem acessos de link. O SQL confere a publicação, e o endpoint público de leitura de resultados não conta acessos sozinho. Assim, um robô que busca uma prévia HTML não infla o contador. Robôs conhecidos, prefetch e navegadores automatizados identificáveis são filtrados; não há promessa de detecção perfeita.
- Visitantes são **navegadores estimados**, não pessoas. O identificador aleatório local expira após 30 dias; no banco, ele aparece somente transformado por HMAC. Limpar o armazenamento, usar outro navegador ou chegar após a expiração pode criar um novo visitante. A soma de únicos diários pode ser maior que o total de únicos do período.
- O botão **Fazer uma checagem** no resultado compartilhado registra `new_check`. Uma conclusão após esse clique registra `check_completed`, com atribuição de até 30 minutos. Esses indicadores contam visitantes distintos. A taxa do painel usa visitantes que também abriram um link dentro dos filtros selecionados; não representa compartilhamentos enviados nem uma taxa de precisão da IA.
- O número de novos links publicados vem de `iev_checks.published_at`, independente do filtro geográfico/de origem; acessos no período podem ser de links publicados antes dele.
- A localização usa `x-vercel-ip-country` e `x-vercel-ip-country-region`, somente quando `VERCEL=1`. País, UF e macrorregião são guardados sem IP bruto, cidade ou coordenadas. Sem esses cabeçalhos, a localização fica desconhecida.
- A origem vem de um conjunto fechado de `utm_source` ou do domínio de `document.referrer`. O endereço completo e parâmetros arbitrários nunca são gravados. O botão próprio do WhatsApp marca o link com `utm_source=whatsapp`; compartilhamentos nativos podem ocultar a origem e aparecer como diretos/não identificados.
- A coleta respeita Do Not Track e Global Privacy Control. A página administrativa não registra audiência. O cliente nunca espera analytics para renderizar ou concluir uma checagem.

## Servidor e banco

A migração `20261017024054_link_audience_tracking.sql` adiciona `iev_audience_events` e as RPCs privadas `iev_record_audience` e `iev_audience_snapshot`. RLS é habilitado e forçado; `anon` e `authenticated` não leem a tabela nem executam essas funções. As funções usam `security invoker` e `search_path` fixo. Somente o servidor com `service_role` grava eventos; os agregados exigem a autenticação administrativa já existente.

A gravação é idempotente por UUID do evento; não há índices JSON em Blob nem leitura/escrita de contadores compartilhados. Índices de data e vínculo permitem agregação no PostgreSQL em vez de transferir eventos ao navegador. O endpoint tem limite próprio por origem, sem usar o orçamento de IA. Falhas da coleta não impedem checagens ou acesso aos links; falhas da consulta aparecem como indisponibilidade no painel, não como zeros.

O painel considera até 90 dias. A cada gravação, são excluídos lotes de até 500 eventos anteriores a 90 dias. Isso não garante exclusão física imediata durante inatividade ou nos backups. Não há backfill: links antigos contam somente as novas visitas após a publicação desta versão.

Configuração: reutiliza `SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` já existentes. `IEV_ANALYTICS_SECRET` é opcional; na ausência, o HMAC usa `ADMIN_SECRET` (ou a chave de serviço como último recurso). Trocar esse segredo altera a identificação estimada. `IEV_AUDIENCE_ENABLED=0` pausa a coleta e mantém o histórico no painel. A política pública de privacidade descreve o armazenamento local, a retenção e a geolocalização aproximada.
