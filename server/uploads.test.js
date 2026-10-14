import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeVerifyInput } from "./uploads.js";
import { cacheKey } from "./cache.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
const image = (context) => ({
  kind: "image",
  text: "",
  context,
  fileName: "captura.png",
  fileMime: "image/png",
  fileData: png.toString("base64"),
});

test("upload de imagem preserva bytes e contexto separado até após renormalização", () => {
  const context = "A publicação alega que esta foto foi feita em Brasília em 2026.";
  const input = normalizeVerifyInput(image(context));
  assert.equal(input.text, "");
  assert.equal(input.context, context);
  assert.deepEqual(input.fileBuffer, png);
  assert.equal(input.fileMime, "image/png");
  assert.equal(normalizeVerifyInput(input).context, context);
  assert.equal(normalizeVerifyInput(image()).context, "");
  assert.equal(normalizeVerifyInput(image(" ")).context, " ");
});

test("contexto de imagem respeita o teto configurado sem truncar silenciosamente", () => {
  const env = { IEV_MAX_TEXT_CHARS: "5" };
  assert.equal(normalizeVerifyInput(image("12345"), env).context, "12345");
  assert.throws(() => normalizeVerifyInput(image("123456"), env), (error) => {
    assert.equal(error.message, "text_too_long");
    assert.equal(error.status, 413);
    return true;
  });
});

test("contexto de imagem não contamina entradas de outras modalidades", () => {
  for (const kind of ["link", "text", "video"]) {
    const input = normalizeVerifyInput({ kind, text: "conteúdo", context: "contexto da imagem" });
    assert.equal(input.text, "conteúdo");
    assert.equal(input.context, "");
  }
});

test("cache separa a mesma imagem por contexto e normaliza espaços e Unicode", () => {
  const input = normalizeVerifyInput(image("Foto de Brasília"));
  const withoutContext = { ...input, context: "" };
  assert.notEqual(cacheKey(input), cacheKey(withoutContext));
  assert.notEqual(cacheKey(input), cacheKey({ ...input, context: "Foto de São Paulo" }));
  assert.equal(cacheKey(input), cacheKey({ ...input, context: "  Foto de Brasi\u0301lia  " }));
  const text = { kind: "text", text: "Afirmação" };
  assert.equal(cacheKey(text), cacheKey({ ...text, context: "contexto da imagem" }));
});
