// Regressões da fronteira de rede: classificação de endereços, política de URL,
// tetos de bytes e revalidação de redirects. Usa servidores locais controlados.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  NetError,
  byteBudget,
  hostPolicy,
  isPublicAddress,
  parseUrlStrict,
  resolvePublicHost,
  safeFetch,
} from "./net.js";
import { locateQuote, normalizeForMatch, textFromHtml } from "./text.js";

test("classifica endereços internos e públicos (IPv4, IPv6, mapeados)", () => {
  const internos = [
    "127.0.0.1", "10.1.2.3", "172.16.5.5", "192.168.0.10", "169.254.169.254",
    "100.64.7.7", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
    "::1", "::", "fe80::1", "fd00::1", "ff02::1", "::ffff:127.0.0.1",
    "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1",
  ];
  for (const ip of internos) assert.equal(isPublicAddress(ip), false, `${ip} deveria ser interno`);
  const publicos = ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"];
  for (const ip of publicos) assert.equal(isPublicAddress(ip), true, `${ip} deveria ser público`);
});

test("política de URL recusa protocolo, credenciais, portas e hosts internos", () => {
  assert.equal(parseUrlStrict("https://g1.globo.com/politica/x").host, "g1.globo.com");
  const casos = [
    ["ftp://example.com/x", "bad_protocol"],
    ["https://user:pass@example.com/x", "url_credentials"],
    ["https://example.com:8443/x", "port_not_allowed"],
    ["http://localhost/x", "private_hostname"],
    ["http://127.0.0.1/x", "private_address"],
    ["http://metadata.google.internal/computeMetadata/v1/", "private_hostname"],
    ["http://intranet/x", "private_hostname"],
    ["http://algo.local/x", "private_hostname"],
    ["http://[::1]/x", "private_address"],
    ["não é url", "bad_url"],
  ];
  for (const [value, code] of casos) {
    assert.throws(() => parseUrlStrict(value), (error) => error instanceof NetError && error.code === code, `${value} → ${code}`);
  }
  const dev = hostPolicy({ IEV_ALLOW_PRIVATE_HOSTS: "1", IEV_HTTP_PORTS: "8080" });
  assert.equal(parseUrlStrict("http://127.0.0.1:8080/x", { policy: dev }).host, "127.0.0.1");
});

test("resolvePublicHost recusa nome que resolve para endereço interno", async () => {
  await assert.rejects(() => resolvePublicHost("localhost"), (error) => error.code === "private_address");
});

async function comServidor(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(port, { allowPrivate: true, ports: [port] });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("safeFetch respeita teto declarado, teto real e truncamento", async () => {
  await comServidor((req, res) => {
    if (req.url === "/declarado") {
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": "5000" });
      res.end("x".repeat(5000));
      return;
    }
    if (req.url === "/sem-tamanho") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      let sent = 0;
      const pump = () => {
        if (sent >= 20000) {
          res.end();
          return;
        }
        sent += 1000;
        if (res.write("y".repeat(1000))) setImmediate(pump);
        else res.once("drain", pump);
      };
      pump();
      return;
    }
    if (req.url === "/budget-chunk") {
      res.writeHead(200, { "Content-Type": "text/plain", "Transfer-Encoding": "chunked" });
      res.end("z".repeat(1000));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("corpo curto");
  }, async (port, policy) => {
    await assert.rejects(() => safeFetch(`http://127.0.0.1:${port}/declarado`, { maxBytes: 1024, policy }), (error) => error.code === "too_large");
    const declared = await safeFetch(`http://127.0.0.1:${port}/declarado`, {
      maxBytes: 1024, truncate: true, policy, budget: byteBudget(10000),
    });
    assert.equal(declared.truncated, true);
    assert.equal(declared.body.length, 1024);
    await assert.rejects(() => safeFetch(`http://127.0.0.1:${port}/sem-tamanho`, { maxBytes: 4000, policy }), (error) => error.code === "too_large");
    const ok = await safeFetch(`http://127.0.0.1:${port}/ok`, { maxBytes: 1000, policy });
    assert.equal(ok.ok, true);
    assert.equal(ok.body.toString(), "corpo curto");
    const parcial = await safeFetch(`http://127.0.0.1:${port}/sem-tamanho`, { maxBytes: 4000, truncate: true, policy });
    assert.equal(parcial.truncated, true);
    assert.equal(parcial.body.length, 4000);
    const budget = byteBudget(100);
    await assert.rejects(
      () => safeFetch(`http://127.0.0.1:${port}/budget-chunk`, { maxBytes: 1024, truncate: true, policy, budget }),
      (error) => error.code === "budget_exhausted",
    );
    assert.ok(budget.used > budget.totalBytes);
    await assert.rejects(
      () => safeFetch(`http://127.0.0.1:${port}/ok`, { maxBytes: 1000, policy, budget: byteBudget(5) }),
      (error) => error.code === "budget_exhausted",
    );
  });
});

test("safeFetch segue redirect legítimo, limita saltos e revalida destino", async () => {
  await comServidor((req, res) => {
    if (req.url === "/a") {
      res.writeHead(302, { Location: "/b" });
      res.end();
      return;
    }
    if (req.url === "/b") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("destino");
      return;
    }
    if (req.url === "/loop") {
      res.writeHead(302, { Location: "/loop" });
      res.end();
      return;
    }
    if (req.url === "/interno") {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  }, async (port, policy) => {
    const seguido = await safeFetch(`http://127.0.0.1:${port}/a`, { maxBytes: 1000, policy });
    assert.equal(seguido.ok, true);
    assert.equal(seguido.body.toString(), "destino");
    assert.equal(seguido.redirects.length, 1);
    await assert.rejects(() => safeFetch(`http://127.0.0.1:${port}/loop`, { maxBytes: 1000, policy }), (error) => error.code === "too_many_redirects");
    await assert.rejects(
      () => safeFetch(`http://127.0.0.1:${port}/interno`, { maxBytes: 1000, policy: { allowPrivate: false, ports: [port, 80] } }),
      (error) => error.code === "private_address",
    );
  });
});

test("safeFetch aplica timeout em resposta que nunca chega", async () => {
  await comServidor((req, res) => {
    if (req.url === "/pendura") return; // nunca responde
    res.writeHead(200);
    res.end("ok");
  }, async (port, policy) => {
    await assert.rejects(
      () => safeFetch(`http://127.0.0.1:${port}/pendura`, { maxBytes: 100, timeoutMs: 300, policy }),
      (error) => error.code === "timeout",
    );
  });
});

test("localização de citação distingue exato, aproximado e ausente", () => {
  const documento = "O instituto divulgou na terça-feira (14) que o candidato tem 52% das intenções de voto, contra 48% do adversário, com margem de erro de dois pontos percentuais.";
  assert.equal(locateQuote(documento, "o candidato tem 52% das intenções de voto").kind, "exact");
  assert.equal(locateQuote(documento, "candidato tem 52% das intencoes de voto contra 48%").found, true);
  const inexistente = locateQuote(documento, "o candidato desistiu da candidatura na semana passada");
  assert.equal(inexistente.found, false);
  assert.ok(inexistente.similarity < 0.8);
  assert.equal(locateQuote(documento, "curto").kind, "missing");
  assert.equal(normalizeForMatch("“aspas” — travessão"), '"aspas" - travessão');
});

test("HTML vira texto legível sem scripts", () => {
  const texto = textFromHtml("<html><head><style>p{color:red}</style><script>alert(1)</script></head><body><p>Linha &amp; uma</p><p>Linha dois</p></body></html>");
  assert.match(texto, /Linha & uma/);
  assert.match(texto, /Linha dois/);
  assert.doesNotMatch(texto, /alert|color:red/);
});
