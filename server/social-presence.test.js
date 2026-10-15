// Gate de presença de mídia em posts sociais (X): sem áudio/vídeo não existe
// anúncio nem tentativa de aquisição; só o texto disponível é checado.
process.env.OPENCODE_API = "test-key";
process.env.MODERATION_MODE = "off";
process.env.IEV_EVIDENCE_FETCH = "0";
process.env.IEV_EVIDENCE_REVIEW = "0";
process.env.IEV_ALLOW_PRIVATE_WORKER = "1";
delete process.env.OPENAI_API_KEY;
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.MEDIA_WORKER_SECRET;

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

const workerRequests = [];
let presencePayload = { ok: false, reason: "no-media", detail: "No video could be found in this tweet" };
const worker = createServer((req, res) => {
  workerRequests.push(req.url);
  res.writeHead(200, { "Content-Type": "application/json" });
  if (req.url === "/fetch") return res.end(JSON.stringify(presencePayload));
  if (req.url === "/media") return res.end(JSON.stringify({ ok: false, reason: "download-failed" }));
  res.end(JSON.stringify({ ok: false, reason: "not_found" }));
});
await new Promise((resolve) => worker.listen(0, "127.0.0.1", resolve));
// O worker precisa estar definido antes do load de media.js/verify.js.
process.env.MEDIA_WORKER_URL = `http://127.0.0.1:${worker.address().port}`;

const { runVerify } = await import("./verify.js");

after(async () => new Promise((resolve) => worker.close(resolve)));

async function withControlledModels(fn) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "muse-spark-1.3-contributor" }] }), { status: 200 });
    }
    const text = JSON.stringify({ outcome: "no_verifiable_claims", verdict: null, score: null, claims: [], sources: [], summary: "Nenhuma alegação verificável identificada." });
    return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text }] }] }), { status: 200 });
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

function collectMediaActivities(events) {
  return new Set(events.filter((event) => event.type === "activity").map((event) => event.id));
}

test("tweet sem áudio/vídeo não anuncia nem baixa mídia e segue com o texto", async () => {
  presencePayload = { ok: false, reason: "no-media", detail: "No video could be found in this tweet" };
  workerRequests.length = 0;
  const events = [];
  await withControlledModels(async () => {
    const out = await runVerify(
      { kind: "link", text: "https://x.com/eixopolitico/status/2110480203315331553" },
      { onProgress: (event) => events.push(event) },
    );
    const ids = collectMediaActivities(events);
    assert.ok(ids.has("media-metadata"), "metadados seguem visíveis no fluxo sem mídia");
    assert.ok(!ids.has("media-acquisition"));
    assert.ok(!ids.has("media-transcription"));
    assert.ok(!ids.has("media-vision"));
    assert.equal(workerRequests.includes("/media"), false, "ausência definitiva não dispara download");
    assert.ok(events.filter((event) => event.type === "content").every((event) => event.coverage.videoLinkDetected !== true));
    assert.ok(out.media.some((entry) => String(entry).startsWith("worker-presence:no-media")));
    assert.ok(out.media.some((entry) => String(entry).includes("attachments:none")));
  });
});

test("tweet com vídeo mantém o anúncio e a tentativa de aquisição", async () => {
  presencePayload = { ok: true, media: { platform: "X", title: "Post com vídeo", hasVideo: true, hasAudio: true } };
  workerRequests.length = 0;
  const events = [];
  await withControlledModels(async () => {
    await runVerify(
      { kind: "link", text: "https://x.com/eixopolitico/status/2110480203315331554" },
      { onProgress: (event) => events.push(event) },
    );
    const ids = collectMediaActivities(events);
    assert.ok(ids.has("media-acquisition"));
    assert.ok(ids.has("media-transcription"));
    assert.ok(ids.has("media-vision"));
    assert.ok(workerRequests.includes("/media"), "presença confirmada tenta adquirir o arquivo");
    const warningIndex = events.findIndex((event) => event.type === "content" && event.coverage.videoLinkDetected === true);
    const acquisitionIndex = events.findIndex((event) => event.type === "activity" && event.id === "media-acquisition");
    assert.ok(warningIndex >= 0 && warningIndex < acquisitionIndex, "vídeo confirmado avisa antes da aquisição");
    assert.equal(events.filter((event) => event.type === "content").at(-1).coverage.videoLinkDetected, true);
  });
});

for (const [label, payload, status] of [
  ["áudio sem vídeo", { ok: true, media: { hasAudio: true, hasVideo: false } }, "2110480203315331555"],
  ["presença indeterminada", { ok: false, reason: "probe-failed" }, "2110480203315331556"],
]) {
  test(`post com ${label} não anuncia vídeo identificado`, async () => {
    presencePayload = payload;
    const events = [];
    await withControlledModels(async () => {
      await runVerify(
        { kind: "link", text: `https://x.com/eixopolitico/status/${status}` },
        { onProgress: (event) => events.push(event) },
      );
      assert.ok(events.filter((event) => event.type === "content").every((event) => event.coverage.videoLinkDetected !== true));
    });
  });
}
