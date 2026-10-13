// Regressões dos limites de mídia: tetos por arquivo, validação de payload do
// worker e recusa de transferência acima do permitido (servidor local controlado).
process.env.IEV_ALLOW_PRIVATE_HOSTS = "1";
const media = await import("./media.js");

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { rm } from "node:fs/promises";

test("limites de mídia vêm do ambiente com valores padrão", () => {
  assert.equal(media.mediaLimits({}).maxMediaSeconds, 900);
  assert.equal(media.mediaLimits({ IEV_MAX_DOWNLOAD_BYTES: "1024" }).maxTransferBytes, 1024);
  assert.equal(media.mediaLimits({ IEV_MAX_MEDIA_SECONDS: "0" }).maxMediaSeconds, 900);
});

test("frames do worker são filtrados por tamanho, quantidade e base64", () => {
  const valido = Buffer.from("frame-jpeg").toString("base64");
  const frames = media.normalizeWorkerFrames([
    { image_b64: valido, timestamp_sec: 1.5 },
    "nao-e-base64!",
    { image_b64: "" },
    { image_b64: Buffer.alloc(900_000).toString("base64") },
  ]);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].timestampSec, 1.5);
  assert.equal(media.normalizeWorkerFrames(Array.from({ length: 40 }, () => ({ image_b64: valido }))).length, 10);
});

async function comServidor(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  process.env.IEV_HTTP_PORTS = String(port);
  try {
    return await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("download direto recusa arquivo acima do teto e aceita arquivo pequeno", async () => {
  await comServidor((req, res) => {
    if (req.url === "/post") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><head><meta property="og:video" content="http://127.0.0.1:${req.socket.localPort}/video.mp4"></head></html>`);
      return;
    }
    if (req.url === "/video.mp4") {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      res.end(Buffer.alloc(120_000, 7));
      return;
    }
    res.writeHead(404);
    res.end();
  }, async (port) => {
    process.env.IEV_MAX_MEDIA_FILE_BYTES = "1000";
    const grande = await media.downloadAudio(`http://127.0.0.1:${port}/post`, "./tmp-dl/test-media");
    assert.equal(grande.ok, false);
    assert.equal(grande.reason, "file-too-large");

    process.env.IEV_MAX_MEDIA_FILE_BYTES = "5000000";
    const pequeno = await media.downloadAudio(`http://127.0.0.1:${port}/post`, "./tmp-dl/test-media");
    assert.equal(pequeno.ok, true);
    assert.equal(pequeno.via, "direct");
    await rm("./tmp-dl/test-media", { recursive: true, force: true }).catch(() => {});
  });
});

test("download de link direto para destino interno é bloqueado", async () => {
  await comServidor((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><head><meta property="og:video" content="http://127.0.0.1:${req.socket.localPort}/video.mp4"></head></html>`);
  }, async (port) => {
    process.env.IEV_ALLOW_PRIVATE_HOSTS = "0";
    delete process.env.IEV_HTTP_PORTS;
    const tentativa = await media.downloadAudio(`http://127.0.0.1:${port}/post`, "./tmp-dl/test-media");
    assert.equal(tentativa.ok, false);
    assert.match(tentativa.reason, /^blocked:/);
    process.env.IEV_ALLOW_PRIVATE_HOSTS = "1";
  });
});
