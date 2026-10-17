// Regressões da imagem de preview: manchete derivada do resultado e fail-open
// para a imagem padrão quando a checagem não está publicada.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleOgImage, renderOgSvg } from "./og-image.js";

const DEFAULT_PNG = readFileSync(new URL("../public/og-default.png", import.meta.url));
const RESULT = { verdict: "unproven", score: 45, summary: "Afirmações analisadas: 1.", claims: [{ text: "Luiz Inácio Lula da Silva odeia a comunidade LGBT." }] };
const published = (body) => async () => ({ status: 200, body });
const missing = async () => ({ status: 404, body: { error: "not_found" } });

/** Texto visível do SVG: as linhas quebradas deixam de estar contíguas no markup. */
const visible = (svg) => svg.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

test("manchete usa primeira afirmação e título da origem quando o resultado não tem título", () => {
  assert.match(visible(renderOgSvg(RESULT)), /Luiz Inácio Lula da Silva odeia a comunidade LGBT\./);
  const comOrigem = renderOgSvg({ ...RESULT, claims: [] }, { title: "Postagem da rede" });
  assert.match(visible(comOrigem), /Postagem da rede/);
  const comTitulo = renderOgSvg({ ...RESULT, title: "Checagem: manchete original" }, { title: "Postagem da rede" });
  assert.match(visible(comTitulo), /manchete original/);
  assert.doesNotMatch(visible(comTitulo), /Postagem da rede/);
  assert.match(visible(renderOgSvg(RESULT, { title: "Postagem da rede" })), /odeia a comunidade LGBT\./);
});

test("afirmação que vira manchete é escapada no SVG", () => {
  const svg = renderOgSvg({ ...RESULT, claims: [{ text: 'aspas " & <script>alert(1)</script>' }] });
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /&lt;script&gt;/);
});

test("checagem publicada gera PNG; não publicada devolve a imagem padrão", async () => {
  const hit = await handleOgImage({ method: "GET", query: { id: "mv-card-123" }, fetchCheck: published({ result: RESULT, origin: { title: "Postagem" } }) });
  assert.equal(hit.status, 200);
  assert.equal(hit.headers["Content-Type"], "image/png");
  assert.equal(hit.headers["Cache-Control"], "public, max-age=3600");
  assert.equal(hit.body.readUInt32BE(16), 1200);
  assert.equal(hit.body.readUInt32BE(20), 630);

  const miss = await handleOgImage({ method: "GET", query: { id: "mv-card-123" }, fetchCheck: missing });
  assert.equal(miss.status, 200);
  assert.equal(miss.headers["Cache-Control"], "public, max-age=300");
  assert.deepEqual(miss.body, DEFAULT_PNG);

  assert.equal((await handleOgImage({ method: "GET", query: { id: "id com espaço" }, fetchCheck: missing })).headers["Cache-Control"], "public, max-age=300");
  const head = await handleOgImage({ method: "HEAD", query: { id: "mv-card-123" }, fetchCheck: published({ result: RESULT }) });
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  assert.equal((await handleOgImage({ method: "POST", query: { id: "mv-card-123" }, fetchCheck: missing })).status, 405);
});
