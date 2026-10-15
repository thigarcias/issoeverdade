import { test } from "node:test";
import assert from "node:assert/strict";
import { getPublishedCheck, verify } from "../src/lib/api.js";

const input = { kind: "text", text: "Afirmação", fileName: null };
const capability = { checkId: "check-stream", recoveryToken: "t".repeat(43) };
const envelope = { checkId: capability.checkId, result: { outcome: "checked", summary: "Concluído: ação e evidência.", claims: [], sources: [] } };
const resultEvent = JSON.stringify({ type: "result", checkId: capability.checkId, envelope });
const accepted = `${JSON.stringify({ type: "accepted", ...capability, contract: "iev-verify-ndjson/1" })}\n`;

function stream(chunks, { error = false, beforeRead } = {}) {
  let index = 0;
  return { ok: true, headers: new Headers({ "content-type": "application/x-ndjson" }), body: { getReader() { return {
    async read() {
      beforeRead?.(index);
      if (index < chunks.length) return { done: false, value: typeof chunks[index] === "string" ? new TextEncoder().encode(chunks[index++]) : chunks[index++] };
      if (error) throw new TypeError("connection lost");
      return { done: true };
    },
    async cancel() {}, releaseLock() {},
  }; } } };
}

async function withFetch(handler, action) {
  const saved = globalThis.fetch;
  globalThis.fetch = handler;
  try { await action(); } finally { globalThis.fetch = saved; }
}

test("complete final result survives EOF and read failure without trailing LF, including split UTF-8", async (t) => {
  for (const error of [false, true]) await t.test(error ? "read error" : "EOF", async () => {
    const bytes = new TextEncoder().encode(resultEvent);
    const split = bytes.indexOf(0xc3) + 1;
    let calls = 0;
    await withFetch(async () => { calls++; return stream([bytes.subarray(0, split), bytes.subarray(split)], { error }); }, async () => {
      const out = await verify(input);
      assert.equal(out.checkId, capability.checkId);
      assert.equal(out.result.summary, envelope.result.summary);
      assert.equal(calls, 1);
    });
  });
});

test("truncated terminal JSON and invalid envelopes never become successful results", async (t) => {
  for (const record of [resultEvent.slice(0, -1), resultEvent.slice(0, resultEvent.indexOf("Concluído") + 5), '{"type":"result","envelope":{}}']) await t.test(record.slice(-20), async () => {
    await withFetch(async () => stream([record]), async () => {
      await assert.rejects(verify(input), (error) => error.code === "upstream_error" && error.recovery === null);
    });
  });
});

test("progress callback exceptions cannot discard terminal result or accepted capability", async () => {
  let seen;
  await withFetch(async () => stream([accepted, '{"type":"content","modality":"text"}\n{"type":"activity","id":"a","state":"done"}\n', `${resultEvent}\n`]), async () => {
    const out = await verify(input, {
      onAccepted(event) { seen = event; throw new Error("UI callback"); },
      onContent() { throw new Error("UI callback"); },
      onActivity() { return Promise.reject(new Error("async UI callback")); },
    });
    assert.equal(seen.recoveryToken, capability.recoveryToken);
    assert.equal(out.result.id, capability.checkId);
  });
});

test("lost terminal delivery triggers exactly one capability GET without repeating POST", async () => {
  const calls = [];
  await withFetch(async (url, opts) => {
    calls.push({ url, opts });
    return opts.method === "POST" ? stream([accepted, resultEvent.slice(0, -3)], { error: true }) : Response.json({ status: "completed", envelope });
  }, async () => {
    const out = await verify(input);
    assert.equal(out.checkId, capability.checkId);
    assert.equal(out.result.recovered, true);
    assert.deepEqual(calls.map((call) => call.opts.method), ["POST", "GET"]);
    assert.equal(calls[1].opts.headers["X-Verify-Recovery"], capability.recoveryToken);
    assert.equal(calls[1].url.includes(capability.recoveryToken), false);
  });
});

test("recovered comparison metadata and stable evidence IDs survive normalization unchanged", async () => {
  const comparison = { status: "partial", groups: [{ total: 12, years: [2021] }], matchedPeriod: false };
  const evidenceReview = { verdict: "context", complete: false };
  const data = { ...envelope, result: { ...envelope.result,
    sources: [{ url: "https://evidence.test/report", outlet: "Report" }],
    claims: [{ text: "Comparação", comparison, evidenceReview, sourceIds: [0], evidence: [{ sourceId: 0, evidenceId: "stable-evidence-id", relation: "context", quote: "2021: 12" }] }],
  } };
  await withFetch(async () => Response.json({ status: "completed", envelope: data }), async () => {
    const out = await verify(input, { recovery: capability });
    assert.equal(out.result.recovered, true);
    assert.equal(out.result.id, capability.checkId);
    assert.deepEqual(out.result.claims[0].comparison, comparison);
    assert.deepEqual(out.result.claims[0].evidenceReview, evidenceReview);
    assert.equal(out.result.claims[0].evidence[0].evidenceId, "stable-evidence-id");
  });
});

test("research assessment reaches streamed, recovered and published clients without becoming verified", async (t) => {
  const data = { ...envelope, createdAt: "2026-10-15T12:00:00.000Z", result: { ...envelope.result,
    verdict: "true", score: 95,
    sources: [{ url: "https://evidence.test/report", outlet: "Report" }],
    claims: [{
      text: "Afirmação pesquisada", status: "true", score: 95, sourceIds: [0],
      assessmentBasis: "web_research", assessmentNote: "x".repeat(1000),
      evidenceReview: { verification: "unavailable", verdict: "unclear" },
      secret: { token: "PRIVATE CLAIM" },
      evidence: [{ sourceId: 0, relation: "supports", verification: "research", quote: "Trecho informado pela pesquisa.", raw: { token: "PRIVATE EVIDENCE" } }],
    }],
  } };
  for (const mode of ["stream", "recovery", "public"]) await t.test(mode, async () => {
    await withFetch(async () => mode === "stream"
      ? stream([JSON.stringify({ type: "result", checkId: data.checkId, envelope: data })])
      : Response.json(mode === "recovery" ? { status: "completed", envelope: data } : data), async () => {
      const result = mode === "public" ? await getPublishedCheck(data.checkId)
        : (await verify(input, mode === "recovery" ? { recovery: capability } : {})).result;
      const claim = result.claims[0];
      assert.equal(claim.status, "true");
      assert.equal(claim.assessmentBasis, "web_research");
      assert.equal(claim.assessmentNote, "x".repeat(800));
      assert.equal(claim.evidence[0].verification, "research");
      assert.equal(claim.secret, undefined);
      assert.equal(claim.evidence[0].raw, undefined);
      assert.doesNotMatch(JSON.stringify(claim), /PRIVATE/);
    });
  });
});

test("client assessment normalization rejects unknown and nested authority fields", async () => {
  const data = { ...envelope, result: { ...envelope.result,
    sources: [{ url: "https://evidence.test/report", outlet: "Report" }],
    claims: ["verified", ["web_research"], { token: "PRIVATE BASIS" }].map((assessmentBasis) => ({
      text: "Afirmação", assessmentBasis, assessmentNote: { token: "PRIVATE NOTE" }, sourceIds: [0],
      evidence: [{ sourceId: 0, relation: "context", verification: ["research"], quote: "Trecho com origem citada." }],
    })),
  } };
  await withFetch(async () => Response.json({ status: "completed", envelope: data }), async () => {
    const { result } = await verify(input, { recovery: capability });
    for (const claim of result.claims) {
      assert.equal(claim.assessmentBasis, null);
      assert.equal(claim.assessmentNote, "");
      assert.equal(claim.evidence[0].verification, null);
    }
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  });
});

test("explicit retry reads recovery only; pending and transient failures retain capability", async (t) => {
  for (const response of [() => Response.json({ status: "pending" }, { status: 202 }), () => Response.json({ error: "recovery_unavailable" }, { status: 503 }), () => { throw new TypeError("network"); }]) await t.test("one GET", async () => {
    let calls = 0;
    await withFetch(async (_url, opts) => { calls++; assert.equal(opts.method, "GET"); return response(); }, async () => {
      await assert.rejects(verify(input, { recovery: capability }), (error) => error.recovery === capability && ["recovery_pending", "recovery_unavailable"].includes(error.code));
      assert.equal(calls, 1);
    });
  });
});

test("failed, unauthorized, missing and expired recovery clears capability without automatically starting POST", async (t) => {
  for (const status of [401, 403, 404, 409]) await t.test(String(status), async () => {
    let calls = 0;
    await withFetch(async (_url, opts) => { calls++; assert.equal(opts.method, "GET"); return Response.json({ error: status === 409 ? "upstream_error" : "recovery_not_found" }, { status }); }, async () => {
      await assert.rejects(verify(input, { recovery: capability }), (error) => error.recovery === null);
      assert.equal(calls, 1);
    });
  });
});

test("cancellation wins over a complete buffered result and prevents recovery lookup", async () => {
  const controller = new AbortController();
  let calls = 0;
  await withFetch(async () => {
    calls++;
    return stream([accepted, resultEvent], { beforeRead(index) { if (index === 2) controller.abort(); } });
  }, async () => {
    await assert.rejects(verify(input, { signal: controller.signal }), { name: "AbortError" });
    assert.equal(calls, 1);
  });
});

test("conexão perdida sem capacidade não tenta GET e informa limitação", async () => {
  const acceptedWithout = `${JSON.stringify({ type: "accepted", checkId: "check-stream", recoveryAvailable: false, contract: "iev-verify-ndjson/1" })}\n`;
  const calls = [];
  await withFetch(async (_url, opts) => {
    calls.push(opts.method);
    return stream([acceptedWithout], { error: true });
  }, async () => {
    await assert.rejects(verify(input), (error) => error.code === "upstream_error" && error.recovery === null && /recuperável/.test(error.message));
    assert.deepEqual(calls, ["POST"], "nenhum GET é tentado sem capacidade");
  });
});

test("recoveryAvailable true mantém uma leitura de recuperação após perda do terminal", async () => {
  const acceptedOffered = `${JSON.stringify({ type: "accepted", ...capability, recoveryAvailable: true, contract: "iev-verify-ndjson/1" })}\n`;
  const calls = [];
  await withFetch(async (_url, opts) => {
    calls.push(opts.method);
    return opts.method === "POST" ? stream([acceptedOffered], { error: true }) : Response.json({ status: "completed", envelope });
  }, async () => {
    const out = await verify(input);
    assert.equal(out.result.recovered, true);
    assert.deepEqual(calls, ["POST", "GET"]);
  });
});

test("token presente com recoveryAvailable falso não é tratado como recuperação", async () => {
  const acceptedContradictory = `${JSON.stringify({ type: "accepted", checkId: "check-stream", recoveryAvailable: false, recoveryToken: "t".repeat(43), contract: "iev-verify-ndjson/1" })}\n`;
  const calls = [];
  await withFetch(async (_url, opts) => {
    calls.push(opts.method);
    return stream([acceptedContradictory], { error: true });
  }, async () => {
    await assert.rejects(verify(input), (error) => error.recovery === null);
    assert.deepEqual(calls, ["POST"]);
  });
});
