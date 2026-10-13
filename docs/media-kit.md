# Kit de mídia — como a IA baixa vídeo de qualquer lugar

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

### 2. `downloadAudio(url, outDir)` — MP3 para transcrição futura

`yt-dlp -x --audio-format mp3` salva em `./media-tmp/<id>.mp3`. Pronto para
ligar no Whisper Turbo quando implementarmos transcrição real.

### 2b. `downloadFrames(url)` — frames do vídeo para OCR/visão

Vídeos de campanha muitas vezes **não têm fala** — a mensagem está no texto
queimado na tela, com trilha musical por cima. Nesses casos o Whisper devolve
só `🎶` e nada do conteúdo é checado.

`downloadFrames` baixa o vídeo (≤480p) e extrai até 10 frames JPEG (448px,
amostrados ao longo dos primeiros 300s). O `runVerify` então manda os frames
para o modelo de visão (`describeFrames`, Muse primeiro / Luna como fallback),
que faz OCR e descreve cada cena. O resultado entra no `mediaContext` como
"Vídeo sem fala — texto na tela e cenas".

**Quando roda:** só quando o áudio não traz fala (transcrição vazia ou só
música) — vídeos com narração não pagam o custo extra.

| Camada | O que faz | Requer |
| ------ | ---------- | ------ |
| worker `/frames` | yt-dlp + ffmpeg no worker, retorna JPEGs em base64 | `MEDIA_WORKER_URL` |
| local | yt-dlp + ffmpeg locais, mesma extração | `yt-dlp` + `ffmpeg` |

### 3. `hasYtDlp()` — detecção de ambiente

Se o binário não existir (ex.: Vercel), o kit pula automaticamente para os
fallbacks HTTP. Nada quebra — só degrada.

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

## Transcrição (API da OpenAI)

- `server/transcribe.js` faz upload do MP3 para `whisper-1` (`verbose_json`).
- Zero binário/modelo local: funciona na Vercel, local, em qualquer lugar.
- Requer `OPENAI_API_KEY`. Custo: $0.006/minuto (~$0.002 por vídeo de 18s).
- Áudios > 25MB são rejeitados (limite da API).
- Legado local: `scripts/transcribe.py` (faster-whisper) mantido para uso
  manual via CLI, fora do pipeline.

## Limites conhecidos

- Posts privados/com login não são acessíveis (yt-dlp sem cookies).
- Instagram: metadados públicos OK via yt-dlp; oEmbed oficial descontinuado.
- Na Vercel (sem binário yt-dlp): metadados via oEmbed/OpenGraph; download de
  áudio tenta `og:video` direto e cai para metadados se indisponível.
  Pipeline 100% completo (yt-dlp + transcrição de qualquer rede) roda no
  ambiente local / servidor com yt-dlp instalado.
