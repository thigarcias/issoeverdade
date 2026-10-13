// Regressões do worker de mídia: autenticação, SSRF, uploads reais e concorrência.
process.env.WORKER_SECRET = "test-secret";
process.env.IEV_WORKER_CONCURRENCY = "1";
process.env.IEV_MAX_MEDIA_SECONDS = "2";
const { guardUrl, server } = await import("./server.js");

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createMediaFixture } from "../server/test-utils/media-fixture.js";

let base = "";
before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const auth = { Authorization: "Bearer test-secret", "Content-Type": "application/json" };

test("worker recusa requisição sem Authorization", async () => {
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  const semAuth = await fetch(`${base}/audio`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://example.com/x" }) });
  assert.equal(semAuth.status, 401);
  const senhaErrada = await fetch(`${base}/audio`, { method: "POST", headers: { ...auth, Authorization: "Bearer outra" }, body: JSON.stringify({ url: "https://example.com/x" }) });
  assert.equal(senhaErrada.status, 401);
});

test("worker recusa URL interna antes de chamar yt-dlp", async () => {
  const bloqueado = await fetch(`${base}/frames`, { method: "POST", headers: auth, body: JSON.stringify({ url: "http://169.254.169.254/latest/meta-data/" }) });
  const json = await bloqueado.json();
  assert.equal(json.ok, false);
  assert.match(json.reason, /^blocked:/);
  await assert.rejects(
    () => guardUrl("http://10.0.0.5/video"),
    (error) => error.code === "private_address",
  );
  await assert.rejects(
    () => guardUrl("file:///etc/passwd"),
    (error) => error.code === "bad_protocol",
  );
});

test("worker recusa URL malformada e upload fora do contrato", async () => {
  const ruim = await fetch(`${base}/fetch`, { method: "POST", headers: auth, body: JSON.stringify({ url: "não é url" }) });
  assert.equal(ruim.status, 400);
  const upload = await fetch(`${base}/upload`, { method: "POST", headers: auth, body: JSON.stringify({ file_b64: "AAAA", mime: "application/pdf" }) });
  const json = await upload.json();
  assert.equal(json.ok, false);
  assert.equal(json.reason, "unsupported-upload");
});

test("worker recusa corpo acima do limite de leitura", async () => {
  const grande = "a".repeat(80 * 1024);
  const resposta = await fetch(`${base}/fetch`, { method: "POST", headers: auth, body: JSON.stringify({ url: "https://example.com/x", padding: grande }) });
  assert.equal(resposta.status, 413);
});
test("worker processa uploads audiovisuais reais e aplica duração ao arquivo original", async (t) => {
  const video = await createMediaFixture(t, { durationSec: 1 });
  if (!video) return;
  const audio = await createMediaFixture(t, { durationSec: 1, video: false });
  if (!audio) {
    await video.cleanup();
    return;
  }
  const silentVideo = await createMediaFixture(t, { durationSec: 1, audio: false });
  if (!silentVideo) {
    await video.cleanup();
    await audio.cleanup();
    return;
  }
  const tooLong = await createMediaFixture(t, { durationSec: 3 });
  if (!tooLong) {
    await video.cleanup();
    await audio.cleanup();
    await silentVideo.cleanup();
    return;
  }
  const upload = async (fixture, mime) => {
    const response = await fetch(`${base}/upload`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ file_b64: fixture.bytes.toString("base64"), mime }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const videoResult = await upload(video, "video/mp4");
    assert.equal(videoResult.ok, true);
    assert.ok(videoResult.audio?.audio_b64.length > 0);
    assert.ok(videoResult.frames.length > 0);
    assert.ok(videoResult.duration_sec > 0);

    const audioResult = await upload(audio, "audio/mpeg");
    assert.equal(audioResult.ok, true);
    assert.ok(audioResult.audio?.audio_b64.length > 0);
    assert.equal(audioResult.frames.length, 0);
    assert.equal(audioResult.frame_reason, "no-video-track");

    const videoOnlyResult = await upload(silentVideo, "video/mp4");
    assert.equal(videoOnlyResult.ok, true);
    assert.equal(videoOnlyResult.audio, null);
    assert.equal(videoOnlyResult.audio_reason, "no-audio-track");
    assert.ok(videoOnlyResult.frames.length > 0);

    const corrupt = await fetch(`${base}/upload`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ file_b64: Buffer.from("corrupt media").toString("base64"), mime: "video/mp4" }),
    }).then((response) => response.json());
    assert.equal(corrupt.ok, false);
    assert.ok(corrupt.reason);

    const longResult = await upload(tooLong, "video/mp4");
    assert.equal(longResult.ok, false);
    assert.match(longResult.reason, /^duration-limit:\d+s$/);
  } finally {
    await Promise.all([video, audio, silentVideo, tooLong].map((fixture) => fixture.cleanup()));
  }
});

test("servidor serverless consome upload pelo worker sem fallback local", async (t) => {
  const fixture = await createMediaFixture(t, { durationSec: 1 });
  if (!fixture) return;
  const { rm, readFile } = await import("node:fs/promises");
  const names = ["VERCEL", "MEDIA_WORKER_URL", "MEDIA_WORKER_SECRET", "IEV_ALLOW_PRIVATE_WORKER"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  let extracted;
  try {
    process.env.VERCEL = "1";
    process.env.MEDIA_WORKER_URL = base;
    process.env.MEDIA_WORKER_SECRET = "test-secret";
    process.env.IEV_ALLOW_PRIVATE_WORKER = "1";
    const media = await import("../server/media.js");
    extracted = await media.processUploadedMedia(fixture.bytes, "video/mp4");
    assert.equal(extracted.ok, true);
    assert.equal(extracted.hasVideo, true);
    assert.ok(extracted.durationSec > 0);
    assert.ok(extracted.frames.length > 0);
    assert.ok((await readFile(extracted.audio.file)).length > 0);

    process.env.MEDIA_WORKER_URL = "";
    const serverlessWithoutWorker = await import("../server/media.js?serverless-without-worker");
    const unavailable = await serverlessWithoutWorker.processUploadedMedia(fixture.bytes, "video/mp4");
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.reason, "worker-unavailable-serverless");
  } finally {
    if (extracted?.dir) await rm(extracted.dir, { recursive: true, force: true });
    await fixture.cleanup();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
