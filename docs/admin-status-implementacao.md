# Admin: status de implementação

Execução do [plano](admin-overview-plano.md) nas fases 1–5. Cada linha aponta a
evidência verificável no código e a verificação executada. Registros antigos
continuam sendo evidência da execução preservada, não prova de comportamento atual.

## Fase 1 — Contratos críticos

| Entrega | Onde | Verificação |
| --- | --- | --- |
| Abstensão sem nota/selo | `server/scoring.js` (`OUTCOMES`, `validateResult`) | smoke: `no_verifiable_claims` com score 99 → `verdict null`, `score null` |
| Schema de saída válido | `RESULT_SHAPE` (JSON real, enums e relações) | smoke: `JSON.parse` do exemplo |
| Status/score/fontes coerentes | âncoras `true 85/90/95`, `context 55/70`, `unproven 35/45`, `false 5/20`; teto 64 com `false` total | smoke: `false 5` + nove `true 95` → score 64, veredito `distorted` |
| Evidência exige vínculo | `validEvidence` (relação, `sourceId`, trecho ≥ 8 caracteres) | smoke: `true` sem fontes → `unproven` |
| Mídia inacessível ≠ enganoso | `verify.js` (`blockedResult.outcome = "inaccessible_media"`, `verdict null`) | smoke do pipeline com falha de provedor e mídia ausente |
| Transcrição efetiva | `server/transcribe.js` envia `model` no multipart, valida provedor/modelo suportados | smoke: `gpt-transcribe` aparece no multipart; provedor não-OpenAI retorna `unsupported-transcription-provider` |
| Score nos logs | `server/checklog.js` (`score` no registro e no índice) | leitura do contrato + smoke do pipeline |
| Sem troca silenciosa de provedor | `callModel` usa apenas o par configurado | smoke: OpenRouter/`gpt-6-luna` no payload e erro 503 sem fallback |

## Fase 2 — Evidência e mídia

| Entrega | Onde | Verificação |
| --- | --- | --- |
| Fonte precisa existir nas citações da busca | `sanitizeSources` (URL específica + citação confirmada + vínculo a claim) | smoke: 1 fonte mantida, citação preservada |
| Trecho por claim | evidência com `relation`, `quote`, `sourceId`; UI mostra citação e link | verificação de painel com fixture (aba Afirmações) |
| Consultas de busca registradas | `extractResponse` captura `web_search_call.action.queries` → `researchQueries` no log e no retorno | smoke: `researchQueries = ["afirmação testada 2026"]` |
| Citações da busca registradas | `researchCitations` no log e no cache | smoke: 1 citação |
| Fala e texto visual complementares | `collectMediaArtifacts` anexa transcrição **e** OCR/visão (sem gate antigo) | leitura do fluxo + smoke do worker |
| Cobertura e instantes amostrados | `mediaCoverage` com `sampledFrameCount`, `sampledFrameTimestamps`, `durationSec`; aba Mídia exibe | verificação de painel: `00:00 · 00:30 · 01:01` |
| Uploads reais | `src/lib/api.js` envia bytes; `server/uploads.js` valida assinatura e limite de 3 MiB | smoke: PNG válido aceito, MIME divergente rejeitado, >3 MiB rejeitado |
| Extração de vídeo verificada localmente | `worker/server.js` (`/upload`, `/audio`, `/frames`) | smoke com MP4 sintético: áudio 13 KB, 2 frames, duração 2 s; MIME inválido rejeitado |

## Fase 3 — Modelos e configuração

| Entrega | Onde | Verificação |
| --- | --- | --- |
| Descoberta server-side | `fetchCatalog` (OpenAI `/v1/models`, Go `/inference/go/v1/models`), cache de 15 min e último inventário válido em Blob | smoke com catálogo mockado: 3 modelos, incluindo incompatível |
| Incompatíveis visíveis e bloqueados | `modelInfo.eligibleSteps/ineligibleReason`; seletor por etapa só oferece elegíveis; `resolvePairs(strict)` no POST | smoke: `text-embedding-3-small` rejeitado com `invalid_ai_config` |
| Falha ao salvar não aplica mudança | `saveAiConfig` valida → grava Blob → só então atualiza memória | leitura + smoke (POST inválido manteve a config anterior) |
| Persistência real informada | `persisted` derivado da gravação; painel mostra “durável (Blob)” ou “efêmera” | verificação de painel |
| Revisão integra a identidade do cache | `cacheNamespace = PROMPT_VERSION:configRevision` | leitura; smoke de cache-hit com namespace |
| Solicitado × usado por fase | `aiConfig`, `modelsUsed`, `configRevision`, `configSource` no log; aba Execução | verificação de painel |
| Compatibilidade documentada | regex Responses por família + transcrição; Go com allowlist explícita | `server/ai-config.js`; capacidades conferidas na documentação OpenAI |

## Fase 4 — Painel administrativo

| Entrega | Onde | Verificação de painel (fixtures) |
| --- | --- | --- |
| Shell e navegação próprios | `Admin.jsx` (`ADMIN_SECTIONS`), `index.css` | 4 seções navegáveis |
| Checagens acessíveis sem config no caminho | card de IA movido para seção própria | tabela renderiza 2 registros; nota 58 visível |
| Tabela no desktop / cards no celular | `.admin-table` × `.admin-cards` | 390 px: `table display:none`, `cards grid`, 2 cards |
| Sem overflow horizontal | `min-width:0`, `overflow-wrap` | 1440 px, 1024 px e 390 px: `scrollWidth == innerWidth` (medição real no navegador) |
| Sidebar fixa no desktop / nav no topo no celular | `.admin-shell` grid + `@media (max-width:900px)` | 1024/1440 px: `position:sticky`, 2 colunas; 390 px: `static`, 1 coluna |
| Filtros separados (busca, ordenação, estado, tipo) | toolbar + URL (`q`, `sort`, `status`, `kind`) | filtro “Vídeo” → 1 checagem; “Limpar filtros” → 2 |
| Detalhe sem reabertura tardia | `detailRequest` invalida requisições | fechar durante o carregamento → diálogo continua fechado 1,5 s depois |
| Aviso de metodologia divergente/legado | `methodologyNotice` | legado: “sem versão de metodologia”; `fact-check-2`: “Produzido sob fact-check-2” |
| Prompts com versão, hash e truncamento | aba Prompts + `promptHashes` | hash `9f1c0d` e rótulo “prévia truncada” exibidos |
| Correções e consultas visíveis | abas Resultado/Execução | correção do validador e `researchQueries` exibidas |
| Metodologia no painel | `AdminMethodology` com versão/faixas/estados/avaliação vindos da API | validação original com `fact-check-3`; código atual usa `fact-check-4`, mantendo ausência de benchmark humano |
| URL canônica decidida e documentada | `/admin` (rewrite em `vercel.json`) + alias `/#/admin` em `README.md` | `/admin` responde 200 no dev com fallback de SPA |
| Registros novos conservam score | índice/registro com `score` e `methodologyVersion` | painel mostra nota e versão por registro |

## Fase 5 — Avaliação e transparência

| Entrega | Onde | Verificação |
| --- | --- | --- |
| Harness reproduzível por versão/modelo/modalidade | `scripts/evaluate-factual.mjs` | smoke: duas execuções idênticas (bootstrap determinístico), 30 métricas com IC, gates de schema |
| Validação de corpus | `validate` (IDs únicos, mapeamento claim/citação, adjudicação completa, consistência entre execuções) | smoke: citação sem julgamento reprovada com mensagem |
| Metodologia pública | `public/metodologia.html`, `docs/metodologia-factual.md` | leitura; link no rodapé e no painel |
| Correções | `public/correcoes.html`, `docs/politica-correcoes.md` | leitura; sem canal inventado |
| Privacidade | `public/privacidade.html`, `docs/privacidade-dados-ia.md` | leitura; cache/logs/localStorage descritos com limites |
| Nenhuma métrica de precisão sem medição | painel e páginas públicas | texto explícito de ausência de benchmark |

## Fase 6 — Produção: segurança, custo, evidências e correções

| Entrega | Onde | Verificação |
| --- | --- | --- |
| Política de URL e anti-rebinding | `server/net.js` (`parseUrlStrict`, `resolvePublicHost`, `safeFetch` com lookup fixado) | `server/net.test.js`: matriz IPv4/IPv6/mapeados/NAT64/6to4, redirect para metadados, tetos e timeout |
| Tetos de transferência e vigia de disco | `server/proc.js`, `server/media.js` | `server/media.test.js`: arquivo acima do teto recusado; destino interno bloqueado; frames do worker filtrados |
| Duração máxima de mídia | `enforceDuration` (`ffprobe`) em `server/media.js` e `worker/server.js` | revisão + smoke de upload |
| Worker fail-closed | `worker/server.js` recusa iniciar sem `WORKER_SECRET`; valida URL; concorrência; limpeza de temporários | `worker/server.test.js` |
| Recusa de texto excedente | `server/uploads.js` (`text_too_long`), contador em `src/components/Verifier.jsx` | `server/endpoint.test.js` |
| Limites publicados | `server/health-endpoint.js` (`GET /api/health`) e `useServerLimits` na interface | `server/admin-endpoint.test.js`; smoke no navegador |
| Abuso/custo compartilhado | `server/limits.js` (taxa, vagas com lease, orçamento, tokens) + `server/endpoint.js` | `server/limits.test.js`, `server/endpoint.test.js` |
| Fail-closed em produção sem backend | `resolveMode` → `blocked` + `blockedPayload` | `server/endpoint.test.js` (503 `limits_unavailable`) |
| Triagem de propósito | `purposeTriage` → `no_verifiable_claims` antes de chamadas de modelo | `server/moderation.test.js`, `server/endpoint.test.js` |
| Moderação de conteúdo | `server/moderation.js` (texto, imagens/frames, transcrição) e estados `content_refused`/`moderation_uncovered` | `server/moderation.test.js` |
| Dossiê de evidências | `server/evidence.js` (documento, HTML/PDF, localização de trecho, revisão de fidelidade) | `server/evidence.test.js` |
| Canal de correções | `server/corrections.js`, `api/corrections.js`, `public/correcoes.html` + `correcoes.js` | `server/corrections.test.js` |
| Correção versionada e cache | `appendCorrectionToLog`, `invalidateCache` (época) | `server/admin-endpoint.test.js` |
| Observabilidade | `server/metrics.js`, painel de métricas e alertas | `server/admin-endpoint.test.js` |

## Pendências reais (não fabricadas)

1. **Corpus humano**: nenhum caso anotado foi entregue; sem ele não há precisão, macro-F1 nem Kappa publicáveis. O harness está pronto e documentado.
2. **Produção**: implantação do worker de mídia, variáveis ativas, ACL do Blob e região não foram verificadas a partir do repositório.
3. **Injection e acessibilidade**: há salvaguarda de prompt, mas não houve teste adversarial nem auditoria WCAG.
4. **Rechecagem**: registros antigos não são reexecutados; rechecar exige reenviar o material (o painel informa a divergência de versão).
5. **Go**: allowlist explícita substitui descoberta total; modelos Go fora da lista aparecem como incompatíveis com motivo.
6. **Filtro por período**: o backend não expõe agregação temporal; a lista é a amostra retida (índice de até 200 registros) e a UI diz isso em vez de sugerir histórico completo.
7. **Texto integral da entrada**: o registro guarda prévia de 300 caracteres (e nome/hash do arquivo), não o conteúdo completo; o detalhe exibe exatamente o que foi retido.
8. **Backend compartilhado em produção**: sem `UPSTASH_REDIS_REST_URL`/`KV_REST_API_*`, produção recusa checagens (fail-closed). Configurar antes de liberar tráfego.
9. **Cobertura de moderação de vídeo**: a inspeção cobre transcrição + até 4 frames; sem `MEDIA_VIDEO_MODERATION=partial_frames_transcript`, vídeo é recusado em produção. É decisão de produto, não pendência técnica.
10. **Egresso do worker**: a barreira de rede é do provedor; o código valida destino e aceita `WORKER_EGRESS_PROXY`, mas não substitui firewall de saída.
11. **Alertas**: limiares padrão existem e aparecem no painel, mas não há integração com plantão/pager nem verificação em produção.
12. **Fila de correções**: estados, histórico e correção versionada existem; prazo de resposta e plantão de atendimento não estão definidos.
