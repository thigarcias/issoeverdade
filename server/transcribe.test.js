import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcribe, transcriptToPrompt } from "./transcribe.js";

async function withAudioFiles(count, fn) {
  const dir = await mkdtemp(join(tmpdir(), "iev-transcribe-test-"));
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  try {
    const files = await Promise.all(Array.from({ length: count }, async (_, index) => {
      const file = join(dir, `${index}.mp3`);
      await writeFile(file, `fixture:${dir}:${index}`);
      return file;
    }));
    await fn(files);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    await rm(dir, { recursive: true, force: true });
  }
}

async function until(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "requests did not reach the expected concurrent state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const textResponse = () => new Response(JSON.stringify({ text: "Afirmação pública de teste." }), { status: 200 });

test("transcrição usa três vagas reais e libera fila sem serializar jobs", async () => {
  await withAudioFiles(5, async (files) => {
    let active = 0;
    let peak = 0;
    const releases = [];
    globalThis.fetch = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => releases.push(resolve));
      active--;
      return textResponse();
    };
    const jobs = files.map((file) => transcribe(file, { model: "gpt-4o-mini-transcribe" }));
    try {
      await until(() => releases.length === 3);
      assert.equal(active, 3);
      releases[0]();
      releases[1]();
      await until(() => releases.length === 5);
      assert.equal(peak, 3);
      releases.forEach((release) => release());
      assert.ok((await Promise.all(jobs)).every((result) => result.ok));
    } finally {
      // Também libera jobs enfileirados quando uma asserção falha.
      globalThis.fetch = async () => textResponse();
      releases.forEach((release) => release());
      await Promise.all(jobs);
    }
  });
});

test("áudio idêntico em voo compartilha chamada e cache separa modelo", async () => {
  await withAudioFiles(2, async ([first, duplicate]) => {
    const { readFile } = await import("node:fs/promises");
    await writeFile(duplicate, await readFile(first));
    let calls = 0;
    const releases = [];
    globalThis.fetch = async () => {
      calls++;
      await new Promise((resolve) => releases.push(resolve));
      return textResponse();
    };
    const a = transcribe(first, { model: "gpt-4o-transcribe" });
    const b = transcribe(duplicate, { model: "gpt-4o-transcribe" });
    let results;
    try {
      await until(() => calls > 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      globalThis.fetch = async () => { calls++; return textResponse(); };
      releases.forEach((release) => release());
      results = await Promise.all([a, b]);
    }
    assert.equal(calls, 1);
    assert.deepEqual(results[0], results[1]);
    await transcribe(first, { model: "gpt-4o-transcribe" });
    assert.equal(calls, 1);
    globalThis.fetch = async () => { calls++; return textResponse(); };
    await transcribe(first, { model: "gpt-4o-mini-transcribe" });
    assert.equal(calls, 2);
  });
});

test("multipart usa modelo escolhido e formato compatível sem inventar timestamps", async () => {
  await withAudioFiles(1, async ([file]) => {
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      requests.push({ model: options.body.get("model"), format: options.body.get("response_format"), mime: options.body.get("file").type });
      return textResponse();
    };
    const whisper = await transcribe(file, { model: "whisper-1" });
    const mini = await transcribe(file, { model: "gpt-4o-mini-transcribe" });
    assert.deepEqual(requests, [
      { model: "whisper-1", format: "verbose_json", mime: "audio/mpeg" },
      { model: "gpt-4o-mini-transcribe", format: "json", mime: "audio/mpeg" },
    ]);
    assert.equal(whisper.model, "whisper-1");
    assert.equal(mini.segments.length, 0);
    assert.match(transcriptToPrompt(mini), /^\[timestamp indisponível\]/);
  });
});

test("falha mantém HTTP e motivo redigido e não fica no cache", async () => {
  await withAudioFiles(1, async ([file]) => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "Falhou token=secret-value https://example.com/?sig=secret Bearer fake-token sk-sensitive" } }), { status: 403 });
    };
    const failure = await transcribe(file);
    assert.equal(failure.ok, false);
    assert.equal(failure.reason, "openai-error");
    assert.equal(failure.status, 403);
    assert.doesNotMatch(failure.detail, /secret-value|fake-token|sk-sensitive|https:\/\//);
    globalThis.fetch = async () => { calls++; return textResponse(); };
    assert.equal((await transcribe(file)).ok, true);
    assert.equal(calls, 2);
  });
});

test("provedor incompatível, arquivo vazio e chave ausente não chamam upstream", async () => {
  await withAudioFiles(1, async ([file]) => {
    globalThis.fetch = async () => assert.fail("unexpected upstream call");
    assert.equal((await transcribe(file, { provider: "opencode" })).reason, "unsupported-transcription-provider");
    await writeFile(file, "");
    assert.equal((await transcribe(file)).reason, "empty-audio");
    delete process.env.OPENAI_API_KEY;
    assert.equal((await transcribe(file)).reason, "no-openai-key");
  });
});
