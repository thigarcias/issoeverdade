import assert from "node:assert/strict";
import test from "node:test";
import { CHECK_ID_LENGTH, CHECK_ID_PATTERN, newCheckId } from "./check-id.js";
import { validCheckId } from "./checklog.js";

test("id curto tem formato fixo, sem caracteres ambíguos e aceito pelo armazenamento", () => {
  const ids = Array.from({ length: 500 }, () => newCheckId());
  for (const id of ids) {
    assert.equal(id.length, CHECK_ID_LENGTH);
    assert.match(id, CHECK_ID_PATTERN);
    assert.ok(validCheckId(id), `id inválido para o log: ${id}`);
    assert.doesNotMatch(id, /[ilou]/);
  }
  assert.equal(new Set(ids).size, ids.length, "ids repetidos indicam sorteio quebrado");
});

test("sorteio é determinístico com bytes injetados e sem viés de resto", () => {
  assert.equal(newCheckId(Buffer.alloc(CHECK_ID_LENGTH)), "0".repeat(CHECK_ID_LENGTH));
  assert.equal(newCheckId(Buffer.alloc(CHECK_ID_LENGTH, 0xff)), "z".repeat(CHECK_ID_LENGTH));
  const bytes = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(newCheckId(bytes), "0123456789ab");
});
