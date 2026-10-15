# Kit de mídia — extração de áudio, vídeo e contexto público

Este documento descreve as ferramentas que o backend usa para extrair conteúdo
de links antes de checar. Tudo roda server-side (`server/media.js`).

## Ferramentas disponíveis

### 1. `fetchMediaContext(url)` — extração em camadas (principal)

URLs comuns de páginas (fora de redes sociais, plataformas de vídeo e arquivos
de mídia) usam extração HTML direta, sem worker/yt-dlp. Redes sociais e vídeo
mantêm as camadas abaixo. Retorna `{ ok, context, media, attempts }`;
`context` é material não confiável para o prompt, não instrução.

| Camada | O que faz | Cobre | Requer |
| ------ | ---------- | ----- | ------ |
| `yt-dlp` | `--dump-json`: título, autor, data, duração, descrição, thumbnail | X, Instagram, TikTok, YouTube, Facebook, Kwai, Reddit, +1000 sites | binário `yt-dlp` no servidor |
| `oEmbed` | JSON oficial do post | X (`publish.twitter.com`), YouTube, TikTok | só HTTP (Instagram removeu o público em 2024) |
| `OpenGraph` | fetch do HTML + tags `og:*`/`twitter:*` | qualquer portal de notícias | só HTTP |

### Extração de notícias

A mesma extração de texto é usada para notícias enviadas diretamente e páginas
vinculadas em posts do X. `safeFetch` mantém política de destinos públicos e
validação de cada redirect (até 3). Notícias diretas usam timeout de 20 s e teto
`IEV_MAX_DOC_BYTES` (padrão 8 MiB), com até 18.000 caracteres de corpo enviados ao
julgamento. Links em posts mantêm até 3 páginas, 512 KiB/15 s por página,
2.500 caracteres de corpo e contexto combinado de até 12.000 caracteres.

A extração usa `articleBody` de JSON-LD Article/NewsArticle quando disponível;
caso contrário, parágrafos em article/main ou na página, removendo scripts,
estilos e blocos de navegação. Metadados incluem título, publicação/site,
descrição, autor e data quando disponíveis. Não há bypass de login/paywall,
execução de JavaScript nem inferência de texto ausente.

- `full`: corpo estruturado recebido sem corte de bytes/caracteres nem
  indicação estruturada de paywall. Significa completo **nesse campo recebido**,
  não garantia de que o site forneceu o artigo editorial inteiro.
- `partial`: parágrafos, metadados, corpo cortado ou indicação de paywall.
- `inaccessible`: falha HTTP/rede, desafio de acesso, formato não HTML ou nenhum
  conteúdo extraível. URL/site permanecem disponíveis como pistas de pesquisa.

O endpoint expõe essa cobertura em `mediaCoverage.article` e na síntese.
Conteúdo extraído passa pela moderação antes do julgamento; ordens embutidas na
página são dados não confiáveis. Inacessibilidade não significa falsidade.

### 2. `downloadMedia(url, outDir, sourceType)` — aquisição da checagem

O `runVerify` adquire uma fonte e extrai áudio MP3 e até 10 frames JPEG (448px)
do mesmo arquivo. URLs diretas passam por `safeFetch`; páginas sociais usam
yt-dlp. Com `MEDIA_WORKER_URL`, usa `POST /media` no worker, sem fallback para
ferramentas locais. Servidor e worker precisam ser implantados juntos; a saúde
do worker atual informa `protocol: 2`.

O ffprobe exige streams e duração legíveis antes da extração, aplicando
`IEV_MAX_MEDIA_SECONDS` (900 s por padrão). A extração de frames cobre uma
amostra temporal, não a leitura integral do vídeo. A transcrição e a visão usam
os pares selecionados pelo admin, sem troca silenciosa de modelo/provedor.
Ambas as modalidades são analisadas quando disponíveis, mesmo com narração:
o texto na tela pode conter afirmações diferentes das faladas. Falha do áudio
não impede descrever frames legíveis, e ausência de fala não confirma nada.

`downloadAudio` e `downloadFrames` continuam disponíveis para aquisição de
uma modalidade pela CLI/integrações. A checagem e a bateria de fontes usam
`downloadMedia` para evitar downloads duplicados.

### 3. `hasYtDlp()` — detecção de ambiente

Detecta o binário local, mas não garante acesso a uma plataforma. Em serverless,
processamento audiovisual depende do worker; formato ilegível ou worker
incompatível gera diagnóstico operacional, nunca um veredito sobre mídia não
lida.

## CLI de teste

```bash
node scripts/fetch-media.mjs <url>            # só metadados
node scripts/fetch-media.mjs <url> --audio    # + baixa o MP3
```

## Tool schema (para agentes/IA com function calling)

```json
{
  "name": "fetch_media",
  "description": "Extrai título, autor, data, duração, descrição e thumbnail de um link de vídeo/post/notícia (X, Instagram, TikTok, YouTube, portais). Use antes de checar qualquer URL.",
  "parameters": {
    "type": "object",
    "properties": {
      "url": { "type": "string", "description": "URL do post, vídeo ou notícia" },
      "download_audio": { "type": "boolean", "description": "Se true, baixa também o MP3 para transcrição" }
    },
    "required": ["url"]
  }
}
```

## Fluxo efetivo (runVerify)

1. **Notícias comuns:** extrai HTML e orienta julgamento com busca web. OpenAI
   recebe escolha obrigatória de ferramenta; OpenCode Go aceita só `auto` e
   recebe a exigência nas instruções. Se a página não abrir, pesquisa
   URL/título/publicação e alegações identificáveis, sem fingir leitura integral.
   `needs_media`, `inaccessible_media`, `insufficient_input` ou ausência de
   chamadas de busca na primeira avaliação acionam uma avaliação de pesquisa,
   não download de vídeo nem abstenção automática. Sem alegação identificável:
   `insufficient_input`; claim identificado sem prova suficiente: `unproven`.
2. **Vídeo com URL/upload:** extração de metadados, áudio/transcrição e frames/
   visão, com moderação e limites. Julgamento e revisão compartilham dossiê.
   Se áudio/visão falharem, mas houver texto do post, checa somente esse texto
   e explicita que anexos não foram examinados. Sem conteúdo: `inaccessible_media`.
3. **Texto e links comuns com resultado suficiente:** um julgamento, sem
   download de áudio/vídeo. A obtenção/revisão dos documentos citados ainda pode
   executar etapas adicionais de evidência.

Quando o pipeline identifica vídeo em um link, a interface avisa que bloqueios
da plataforma podem impedir a extração e recomenda enviar o arquivo diretamente.
O botão do aviso cancela a tentativa atual e abre a aba de upload. A tentativa
por link continua até essa ação; o aviso permanece se houver falha. Posts
ambíguos só recebem o aviso após confirmação de vídeo; áudio sem vídeo e uploads
não recebem essa recomendação.

## Transcrição (API da OpenAI)

- `server/transcribe.js` envia o modelo OpenAI selecionado na configuração.
  Whisper usa `verbose_json`/segmentos; os outros adapters suportados usam
  `json`/texto e indicam timestamp indisponível quando não há segmentação.
- Requer `OPENAI_API_KEY`; o custo depende do modelo configurado.
- Áudios > 25 MiB e arquivos vazios são rejeitados antes do upstream.
- Até três chamadas locais simultâneas, fila FIFO e deduplicação em voo por
  hash/provedor/modelo. Só sucessos entram no cache. Erros preservam status
  HTTP e detalhe redigido; não trocam modelo nem viram evidência factual.
- Legado local: `scripts/transcribe.py` (faster-whisper) mantido para uso
  manual via CLI, fora do pipeline.

## Limites conhecidos

- Posts privados/com login não são acessíveis (yt-dlp sem cookies).
- Instagram: metadados públicos OK via yt-dlp; oEmbed oficial descontinuado.
- Vercel precisa do worker atual para processar áudio/vídeo. O worker valida
  duração e conteúdo; worker antigo sem `/media` é identificado como
  `worker-protocol-incompatible`, sem aceitar áudio sem duração como contorno.
- Testes locais controlados não medem acesso real a posts privados, ASR/OCR,
  latência/cold start ou precisão factual de provedores em produção. O diagnóstico
  por ID e as evidências recentes estão em
  [Mídia e links sociais](midia-links-sociais.md#diagnóstico-dos-relatos-de-mídia-e-demora-13102026).
