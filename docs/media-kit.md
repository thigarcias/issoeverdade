# Kit de mídia — como a IA baixa vídeo de qualquer lugar

Este documento descreve as ferramentas que o backend usa para extrair conteúdo
de links antes de checar. Tudo roda server-side (`server/media.js`).

## Ferramentas disponíveis

### 1. `fetchMediaContext(url)` — extração em camadas (principal)

Tenta em ordem, para na primeira que funciona. Retorna
`{ ok, context, media, attempts }` — `context` é texto pronto pro prompt.

| Camada | O que faz | Cobre | Requer |
| ------ | ---------- | ----- | ------ |
| `yt-dlp` | `--dump-json`: título, autor, data, duração, descrição, thumbnail | X, Instagram, TikTok, YouTube, Facebook, Kwai, Reddit, +1000 sites | binário `yt-dlp` no servidor |
| `oEmbed` | JSON oficial do post | X (`publish.twitter.com`), YouTube, TikTok | só HTTP (Instagram removeu o público em 2024) |
| `OpenGraph` | fetch do HTML + tags `og:*`/`twitter:*` | qualquer portal de notícias | só HTTP |

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

## Fluxo em 2 passes (runVerify)

1. **Passo 1 — rápido:** metadados do link (yt-dlp probe / oEmbed / OpenGraph).
   A IA julga com o que tem; se faltar conteúdo, responde `{"needs_media":true}`.
2. **Passo 2 — sob demanda:** só roda se a IA pedir mídia **ou** se for vídeo
   com URL (vídeo sempre transcreve). Baixa o MP3 (`downloadAudio`) +
   transcreve com Whisper (`transcribe`) + rejulga com a transcrição.
   **Sem fala no áudio?** Extrai frames (`downloadFrames`) e roda OCR/visão
   (`describeFrames`) para capturar o texto na tela, e rejulga com ele.

Texto puro e links com conteúdo suficiente: 1 passo, sem download.

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
