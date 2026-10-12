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

## Limites conhecidos

- Posts privados/com login não são acessíveis (yt-dlp sem cookies).
- Instagram: metadados públicos OK via yt-dlp; oEmbed oficial descontinuado.
- Vercel functions não têm `yt-dlp`/`ffmpeg` — lá valem as camadas HTTP
  (oEmbed + OpenGraph). Para yt-dlp em produção: self-host ou API externa
  (ex.: Cobalt API) como camada adicional.
- Transcrição do áudio (Whisper) ainda não ligada — o prompt avisa o modelo
  dessa limitação para vídeos.
