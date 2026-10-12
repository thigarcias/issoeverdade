#!/usr/bin/env node
// CLI de teste do kit de mídia: node scripts/fetch-media.mjs <url> [--audio]
// --audio: além dos metadados, baixa o MP3 para ./media-tmp/
import { downloadAudio, fetchMediaContext, hasYtDlp } from "../server/media.js";

const url = process.argv[2];
if (!url) {
  console.error("Uso: node scripts/fetch-media.mjs <url> [--audio]");
  process.exit(1);
}

console.log("yt-dlp disponível:", await hasYtDlp());
const t0 = Date.now();
const out = await fetchMediaContext(url);
console.log(`Tentativas: ${out.attempts.join(" → ")} (${Date.now() - t0}ms)`);
if (!out.ok) {
  console.error("FALHOU: nenhuma camada extraiu conteúdo.");
  process.exit(2);
}
console.log("--- contexto extraído ---");
console.log(out.context);
if (out.media?.thumbnail) console.log("thumbnail:", out.media.thumbnail.slice(0, 120));

if (process.argv.includes("--audio")) {
  console.log("--- baixando áudio ---");
  const dl = await downloadAudio(url);
  console.log(dl.ok ? `MP3 salvo em: ${dl.file}` : `falhou: ${dl.reason} ${dl.detail ?? ""}`);
}
