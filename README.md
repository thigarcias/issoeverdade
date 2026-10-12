# isso é verdade?

Verificador minimalista de conteúdo político — Brasil, segundo turno 2026.
Cole um link, texto, imagem ou vídeo e receba um **score da verdade** (0–100),
com cada afirmação checada e suas fontes.

## Rodar localmente (com IA de verdade)

```bash
npm install
npm run dev     # http://localhost:5173
```

Crie um `.env` na raiz (nunca commitar — já está no `.gitignore`):

```bash
OPENCODE_API=sua-key-do-opencode-go
# Opcional (padrão: muse-spark-1.3-contributor):
OPENCODE_MODEL=muse-spark-1.3-contributor
```

Em dev, o Vite serve `POST /api/verify` via `vite.api-plugin.js`: a key fica
só no servidor (Node) e o frontend chama o modelo **Muse Spark 1.3 Contributor**
pelo gateway OpenCode Go (`/zen/go/v1/responses`). O header mostra **ao vivo**
quando o backend responde, e cada resultado real leva o selo **ao vivo · IA**.

Sem backend ou sem key, o site cai sozinho para a **demonstração local**
(mock), avisando via toast — o feed de exemplos continua mockado de propósito.

## O que funciona

- **Verificador**: 4 abas — link, texto, vídeo/áudio, imagem — com drag & drop,
  exemplos clicáveis, checagem rápida no topo e pipeline em 5 etapas.
- **Resultado (IA)**: veredito, score 0–100, afirmações com score individual,
  notas e fontes clicáveis retornadas pelo modelo, normalizadas em `src/lib/api.js`.
- **Resultado (mock)**: mesmos componentes, com transcrição trecho a trecho
  nos cenários de vídeo/áudio.
- **Feed**: busca full-text, filtros por veredito, cards com score e modal.
- Responsivo (mobile 390px testado) e `prefers-reduced-motion` respeitado.

## Notas da integração

| Item | Detalhe |
| ---- | ------- |
| Endpoint | `https://opencode.ai/zen/go/v1/responses` (Responses API; o modelo não aceita Chat Completions) |
| Modelo padrão | `muse-spark-1.3-contributor` (assinatura Go; o `-free` só roda dentro do OpenCode) |
| Reasoning | `effort: low` — no padrão o modelo gasta os tokens pensando e não responde |
| Headers Go | `User-Agent: issoeverdade/0.1` + `x-opencode-session` por checagem (exigência anti-abuso) |
| Custo aprox. | $0.10/$0.20 por 1M tokens; ~226 mil checagens/mês no Go |

## Design

Inspirado em [bolsomaster.site](https://bolsomaster.site/): fundo creme
`#F2ECDC`, tinta `#1A140C`, vermelho `#D9341F`, serifada Faustina + Geist,
cards com borda dura e sombra offset.
