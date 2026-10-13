# Extração de conteúdo vinculado em posts de redes sociais

## Contexto

O verificador recebe links de posts (X/Twitter, Instagram, TikTok, etc.) e, para esses casos,
o texto disponível costuma ser apenas o texto do post. Se o post contém um link para uma
matéria/artigo, o texto do tweet isolado pode ser insuficiente para checar a afirmação.

Exemplo testado:

- URL: `https://x.com/folha/status/2110064007184842779`
- Texto do tweet: "Jovem Pan é acusada de crime eleitoral por divulgar pesquisa interna de Flávio Bolsonaro"
- Link vinculado no tweet: `https://t.co/KEAPaHx3vu` -> matéria da Folha

## Comportamento observado antes da correção

Para a URL acima, o sistema:

1. Extraía o tweet com sucesso via oEmbed (`publish.twitter.com/oembed`).
2. Marcava `postTextOnly = true`, porque não havia áudio/transcrição/visão.
3. O resultado indicava cobertura limitada e `inaccessible_media`. Não foi capturado o retorno bruto do modelo dessa execução; não é possível atribuir o resultado a `needs_media = true`.
4. O resultado final virava `inaccessible_media`, sem veredito nem score.

Resumo exibido ao usuário:

- "Cobertura limitada ao texto disponível do post; imagens, áudio e vídeo anexados não foram examinados."
- "A mídia necessária não ficou acessível; não foi atribuído veredito factual."

## Causa

A camada de mídia para X extraía apenas o texto do tweet, sem seguir os links citados no próprio texto.
Isso limita o material entregue ao modelo. Sem o retorno bruto da execução original, não é possível afirmar qual condição do julgamento produziu a abstenção.

## Correção aplicada

Arquivo alterado: `server/media.js`

Foi adicionado um resolvedor genérico de links presentes no texto extraído:

- `extractUrls(text)`: extrai URLs HTTP/HTTPS de forma genérica.
- `fetchLinkedContext(text, attempts)`: segue até 3 URLs presentes no texto.
  - Ignora URLs de redes sociais (`x.com`, `twitter.com`).
  - Ignora extensões de mídia/arquivo (`jpg`, `png`, `mp4`, `pdf`, etc.).
  - Usa `safeFetch`, respeitando a política de rede, teto de bytes e timeout.
  - Quando o host de terceiros retorna HTML, extrai:
    - `og:title` / `twitter:title`;
    - `og:description` / `twitter:description` / `description`;
    - corpo estruturado `articleBody`, quando disponível, ou parágrafos HTML,
      removendo scripts/estilos e blocos de navegação, com limite de tamanho.
  - Registra tentativas em `attempts` (`linked:ok:...`, `linked:http-...`, etc.).
- No caminho de X (`isX`), o contexto retornado passou a incluir:
  - texto do post original;
  - conteúdo vinculado extraído (título, descrição e trecho da matéria).
- `media.postText` passou a combinar texto do post + conteúdo vinculado, preservando o comportamento de `postTextOnly`.

## Resultado do teste com a mesma URL

Tentativas:

- `oembed:ok`
- `linked:ok:t.co`

Contexto passou a incluir a matéria da Folha:

- Título: "Outro Canal: Jovem Pan é acusada de crime eleitoral por divulgar pesquisa interna de Flávio Bolsonaro"
- Descrição: "OUTRO LADO: emissora diz que não vai se posicionar porque não foi notificada"
- Trecho da matéria com o fato principal (denúncia ao TSE pela campanha de Lula por divulgar pesquisa interna de Flávio Bolsonaro).

Resultado final antes da correção:

- outcome: `inaccessible_media`
- verdict: `null`
- score: `null`

Resultado final depois da correção:

- outcome: `checked`
- verdict: `unproven`
- score: `35`

## Validação

Comandos executados:

- `node -e "import('./server/media.js')..."` para validar importação e context extraído.
- `node test-verify.mjs` usando `handleVerifyRequest` com a URL real.
- `node --test server/media.test.js`
- `npx oxlint server/media.js`

Resultados:

- media tests: 4/4 passando.
- oxlint: sem erros.
- endpoint com URL real: `checked`, `unproven`, score `35`, sem `inaccessible_media`.

## Escopo e comportamento atual

O resolvedor genérico é chamado quando um caminho social expõe texto utilizável por oEmbed, worker, yt-dlp ou OpenGraph; texto do post e conteúdo vinculado permanecem campos separados. Segue no máximo 3 links públicos documentais, com teto de 512 KiB e 15 s por página, corpo de até 2.500 caracteres e contexto conjunto de até 12.000. Deduplica URLs, ignora o próprio post, links sociais e arquivos de mídia, e não percorre links recursivamente. Falha de link externo não apaga o texto do post. Conteúdo não extraído, login-wall e anexos inacessíveis não são declarados como lidos.

## Commit

- Commit: `media: resolve linked articles from social posts generically`
- Hash: `a8f89a2`
- Branch: `main`
- Push realizado para `origin/main`.

## Reavaliação após persistência do erro

- A captura enviada pelo usuário ainda mostra `inaccessible_media`, zero afirmações e zero fontes, em cerca de três segundos.
- A alteração original não mudou o namespace `post-text-v1` do cache em `server/verify.js`. Assim, uma resposta anterior podia ser devolvida antes da nova extração.
- Correção: o namespace passou a `post-linked-content-v2`, separando resultados antigos das novas execuções. Isso depende de implantar a versão atual do servidor.
- A captura não mostra `cached`, `cachedFrom`, versão implantada ou tentativas de mídia. Portanto, cache antigo é uma causa possível comprovada pelo código, não uma identificação conclusiva da execução capturada.
- O resultado local `checked/unproven` foi observado em uma execução; outra execução durante o desenvolvimento retornou `insufficient_input`. O teste não provou estabilidade do julgamento nem correção em produção.
- A ausência de fontes não deve ser mascarada atribuindo um veredito positivo. É necessário distinguir falha de extração, conteúdo parcial e insuficiência de evidência.
- Verificação desta reavaliação: um smoke com `setCached/getCached` confirmou que a entrada antiga continua no namespace antigo, mas não é recuperada pelo novo; uma entrada nova é recuperada normalmente.
- Extração real desta reavaliação: `fetchMediaContext` para o URL da Folha retornou `ok: true`, `oembed:ok` e `linked:ok:t.co`, com título, descrição e trecho. Isso comprova extração local, não implantação nem julgamento em produção.

## Extração compartilhada com notícias diretas

O extrator de páginas vinculadas agora compartilha a leitura de metadados/corpo
com notícias enviadas diretamente. Posts mantêm até 3 links, 512 KiB/15 s por
página, corpo de até 2.500 caracteres e contexto combinado de até 12.000.
Cada trecho é identificado como contexto limitado, sem prometer artigo
integral. A revisão atual do cache é `article-content-v4`, mantendo a metodologia
`fact-check-5`; o histórico acima descreve execuções anteriores e não comprova a
implantação atual.

O mesmo roteamento classifica HTML, post social, PDF, imagem, áudio e vídeo.
Notícias comuns não disparam download audiovisual; Spotify só trata episódios
como candidatos a áudio. PDFs textuais usam `fetchDocument`/`unpdf`, imagens
diretas passam por `safeFetch`, validação e visão, e áudio/vídeo exigem stream e
duração legíveis. Upload local usa ffprobe/ffmpeg somente sem worker e fora de
serverless; worker configurado não tem fallback silencioso. Mídia não lida não
gera veredito factual.