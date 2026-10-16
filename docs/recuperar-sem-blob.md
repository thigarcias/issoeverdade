# Recuperar o site com o Blob bloqueado

1. No projeto Supabase já conectado à Vercel, abra **SQL Editor → New query**.
2. Cole todo o conteúdo de `supabase/migrations/202610160001_private_state.sql` e toque em **Run**. A migração é repetível e não apaga dados.
3. Na Vercel, espere o deployment do commit desta correção ficar **Ready**.
4. Abra o painel administrativo do site, vá a **Modelos & provedores**, escolha os modelos que usava e toque em **Salvar modelos**. Esta escolha passa a ser gravada no Supabase. Nenhum modelo substituto é escolhido automaticamente.
5. Faça uma checagem curta pelo site.

Não é necessário remover `BLOB_READ_WRITE_TOKEN`: quando o Supabase está configurado, configuração, catálogo, cache, recuperação e correções usam Supabase exclusivamente. Os logs e links compartilhados já usam a tabela `iev_checks` existente.

O servidor precisa de `SUPABASE_URL` (ou `NEXT_PUBLIC_SUPABASE_URL`) e `SUPABASE_SERVICE_ROLE_KEY`, que já devem estar configuradas em Production. A chave pública anon não serve para esta persistência. Se a tabela de logs ainda não existe, aplique também a migração anterior `202610140001_private_checks.sql`.

Os arquivos antigos no Blob são preservados, mas não podem ser copiados enquanto o acesso estiver bloqueado. O cache começa vazio e solicitações antigas de correção guardadas apenas no Blob ficam indisponíveis até sua importação. Checagens já salvas no Supabase permanecem disponíveis. A recuperação de execuções antigas no Blob também permanece indisponível; novas execuções usam o Supabase.

Se o painel continuar bloqueando a edição depois de aplicar o SQL, aguarde até 60 segundos e toque em **Recarregar configuração**. A configuração vazia no Supabase permite selecionar e salvar os modelos; uma falha de leitura mantém o bloqueio para não sobrescrever uma configuração desconhecida.
