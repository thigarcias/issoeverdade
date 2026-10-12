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

## Fluxo em 2 passes (runVerify)

1. **Passo 1 — rápido:** metadados do link (yt-dlp probe / oEmbed / OpenGraph).
   A IA julga com o que tem; se faltar conteúdo, responde `{"needs_media":true}`.
2. **Passo 2 — sob demanda:** só roda se a IA pedir mídia **ou** se for vídeo
   com URL (vídeo sempre transcreve). Baixa o MP3 (`downloadAudio`) +
   transcreve com Whisper (`transcribe`) + rejulga com a transcrição.

Texto puro e links com conteúdo suficiente: 1 passo, sem download.

## Transcrição (Whisper)

- Worker: `scripts/transcribe.py` (faster-whisper, modelo `large-v3-turbo`).
- Ponte Node: `server/transcribe.js` (fila serial, cache, fallback sem prompts).
- CUDA se `torch.cuda.is_available()`, senão CPU int8 (~14s p/ 18s de áudio).
- Trocar modelo: `WHISPER_MODEL=tiny|base|small|medium|large-v3` no `.env`.

## Limites conhecidos

- Posts privados/com login não são acessíveis (yt-dlp sem cookies).
- Instagram: metadados públicos OK via yt-dlp; oEmbed oficial descontinuado.
- Vercel functions não têm `yt-dlp`/`ffmpeg`/Python — lá valem as camadas HTTP
  (oEmbed + OpenGraph) e o passo 2 é pulado (`hasYtDlp()`/`hasTranscriber()`
  retornam false). Para pipeline completo em produção: self-host ou API externa.
