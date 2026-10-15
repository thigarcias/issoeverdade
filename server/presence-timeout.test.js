// Exercita subprocessos reais contra uma origem local que nunca responde.
process.env.IEV_ALLOW_PRIVATE_HOSTS = "1";
process.env.WORKER_SECRET = "presence-timeout-test";
process.env.IEV_WORKER_CONCURRENCY = "1";
delete process.env.MEDIA_WORKER_URL;

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
const media = await import("./media.js");
const { server: worker } = await import("../worker/server.js");

async function withStalledSource(fn) {
  const source = createServer(() => {});
  await new Promise((resolve) => source.listen(0, "127.0.0.1", resolve));
  const previousPorts = process.env.IEV_HTTP_PORTS;
  process.env.IEV_HTTP_PORTS = String(source.address().port);
  try {
    await fn(`http://127.0.0.1:${source.address().port}/clip`);
  } finally {
    source.closeAllConnections();
    await new Promise((resolve) => source.close(resolve));
    if (previousPorts === undefined) delete process.env.IEV_HTTP_PORTS;
    else process.env.IEV_HTTP_PORTS = previousPorts;
  }
}

test("presença local respeita timeout personalizado e continua indeterminada", async (t) => {
  if (!(await media.hasYtDlp())) return t.skip("yt-dlp indisponível");
  await withStalledSource(async (url) => {
    const start = Date.now();
    const result = await media.probeMediaPresence(url, { timeoutMs: 500 });
    assert.equal(result.hasMedia, null);
    assert.equal(result.reason, "ytdlp-timeout");
    assert.ok(Date.now() - start < 4000, "não deve aguardar o teto antigo de 60s");
  });
});

test("timeout remoto libera a única vaga antes da próxima aquisição", async (t) => {
  if (!(await media.hasYtDlp())) return t.skip("yt-dlp indisponível");
  await new Promise((resolve) => worker.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${worker.address().port}`;
  const names = ["MEDIA_WORKER_URL", "MEDIA_WORKER_SECRET", "IEV_ALLOW_PRIVATE_WORKER"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const auth = { Authorization: "Bearer presence-timeout-test", "Content-Type": "application/json" };
  try {
    process.env.MEDIA_WORKER_URL = base;
    process.env.MEDIA_WORKER_SECRET = "presence-timeout-test";
    process.env.IEV_ALLOW_PRIVATE_WORKER = "1";
    const remote = await import("./media.js?presence-timeout-remote");
    await withStalledSource(async (url) => {
      const result = await remote.probeMediaPresence(url, { timeoutMs: 5000 });
      assert.equal(result.hasMedia, null);
      assert.equal(result.reason, "probe-timeout", "worker deve responder antes do timeout HTTP");
      // O corpo inválido retorna 400 apenas se a vaga já estiver livre (ocupado retorna 503).
      const next = await fetch(`${base}/media`, {
        method: "POST", headers: auth, body: JSON.stringify({ url: "invalid" }),
      });
      assert.equal(next.status, 400, "probe encerrado não deve causar worker-busy");

      // Simula também desconexão antes do prazo interno do worker.
      await assert.rejects(fetch(`${base}/fetch`, {
        method: "POST", headers: auth, body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(500),
      }));
      const deadline = Date.now() + 4000;
      let status;
      do {
        const response = await fetch(`${base}/media`, {
          method: "POST", headers: auth, body: JSON.stringify({ url: "invalid" }),
        });
        status = response.status;
        await response.arrayBuffer();
        if (status !== 503) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      assert.equal(status, 400, "desconexão deve cancelar o subprocesso e liberar a vaga");
    });
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    worker.closeAllConnections();
    await new Promise((resolve) => worker.close(resolve));
  }
});
