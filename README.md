# isso é verdade?

Verificador automático de afirmações públicas no Brasil. Envie link, texto,
imagem ou vídeo e receba um resultado com afirmações, evidências vinculadas,
limites explícitos e, quando houver base, uma nota 0–100. A nota **não** é
probabilidade calibrada e o sistema pode não atribuir veredito.

## Rodar localmente

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # build de produção
npm run lint       # oxlint
```

Crie um `.env` na raiz (já ignorado pelo git):

```bash
OPENAI_API_KEY=...            # julgamento/final/visão e transcrição OpenAI
OPENCODE_API=...              # provedor alternativo (OpenCode Go)
ADMIN_SECRET=...              # habilita /admin
BLOB_READ_WRITE_TOKEN=...     # opcional: cache/logs/config privados na Vercel Blob
MEDIA_WORKER_URL=...          # opcional: worker de extração de áudio/frames
MEDIA_WORKER_SECRET=...
```

Sem `BLOB_READ_WRITE_TOKEN`, cache, logs e configuração ficam apenas em memória
da instância (o código registra isso na interface em vez de fingir persistência).

## Rotas

| Rota | Papel |
| --- | --- |
| `/` | site público: verificador, histórico local e transparência |
| `/admin` | **URL canônica do painel** — `vercel.json` reescreve para o SPA; em Vite dev o fallback de SPA já resolve |
| `/#/admin` | alias equivalente aceito pelo roteador do app |
| `POST /api/verify` | execução da checagem (`api/verify.js` na Vercel, `vite.api-plugin.js` em dev) |
| `GET/POST /api/admin` | lista/detalhe de registros e catálogo+configuração de IA (Bearer `ADMIN_SECRET`) |
| `/metodologia.html`, `/correcoes.html`, `/privacidade.html` | transparência pública |

Deep-link do detalhe: `/admin?detail=<id>` (restaurado no carregamento e no
`popstate`, sem reabrir um detalhe já fechado quando a resposta chega atrasada).

## Chaves e modelos

As chaves ficam somente no servidor. Modelos são escolhidos **por etapa**
(julgamento, conclusão, visão/OCR, transcrição) em *Modelos & provedores*, a
partir do inventário descoberto nos provedores configurados:

- Modelos sem protocolo/capacidade validados aparecem no inventário com o
  motivo, mas não podem ser selecionados.
- Combinação incompatível é rejeitada no servidor (HTTP 400 com campo
  específico) e **não** altera a configuração vigente.
- Não há troca automática de provedor quando uma etapa falha: a falha é
  registrada como erro operacional e o par escolhido é o que executa.
- A configuração é versionada (revisão) e a revisão integra o namespace do
  cache, então uma nova revisão não reaproveita resultado antigo.

Variáveis opcionais de compatibilidade: `IEV_<ETAPA>` (JSON por etapa) e
`OPENAI_TRANSCRIBE_MODEL`.

## Dados e privacidade

Uploads de imagem/vídeo enviam os bytes reais (limite de 3 MiB, validação por
assinatura de arquivo). Resultados recentes ficam em `localStorage` (até 20) no
navegador. No servidor, logs e cache só são duráveis com Blob privado
configurado; limites e lacunas estão em [docs/privacidade-dados-ia.md](docs/privacidade-dados-ia.md).

Posts do X têm seu texto extraído pelo oEmbed oficial antes das tentativas de
metadados via downloader. Se áudio e visão não estiverem disponíveis, mas houver
texto do post, a checagem se limita às afirmações explícitas nesse texto e mostra
o aviso de que os anexos não foram examinados. Sem conteúdo acessível, mantém
`inaccessible_media`, sem nota/veredito. O namespace do cache inclui a revisão
de extração `post-text-v1` para não reaproveitar a antiga abstenção desse caminho.
O cronômetro da interface é inicializado a cada envio e mede a duração daquela
checagem, não o tempo desde a época Unix.

## Metodologia e avaliação

`fact-check-4` captura anotações e fontes estruturadas da busca, compartilha o
dossiê entre julgamento/revisão, distingue períodos de pesquisa e paraleliza
transcrição/visão. `/admin` exibe o diagnóstico de proveniência e as subetapas
de mídia. Fontes somente escritas pelo modelo continuam sendo descartadas.
Regressões de evidência temporal e justificativas: `node --test server/scoring.test.js`.


- [docs/metodologia-factual.md](docs/metodologia-factual.md): fluxo efetivo,
  estados operacionais, faixas de score e limites de evidência.
- [docs/politica-correcoes.md](docs/politica-correcoes.md): o que o sistema
  corrige automaticamente e ausência de canal público de correção.
- [docs/admin-overview-plano.md](docs/admin-overview-plano.md): plano/auditoria
  que originou esta implementação.
- [docs/admin-status-implementacao.md](docs/admin-status-implementacao.md):
  status por fase, evidências e pendências reais.
- Harness de avaliação: `node scripts/evaluate-factual.mjs <corpus.jsonl>`
  (métricas por versão/modelo/modalidade, bootstrap determinístico por `caseId`).
  **Não há corpus humano entregue nem taxa de precisão publicada.**

## Design

Creme `#F2ECDC`, tinta `#1A140C`, vermelho `#D9341F`, serifada Faustina + Geist,
bordas duras e sombra offset. O shell administrativo reusa a identidade com
tipografia sans para dados/controles e navegação lateral no desktop.
