// Identificador público da checagem: ele aparece na URL compartilhada, então
// precisa ser curto, sem caracteres ambíguos e difícil de adivinhar.
// Base32 de Crockford (sem i, l, o e u), 12 caracteres ≈ 60 bits.
// O ID não é segredo: publicação exige a capacidade privada e a recuperação
// exige o segredo separado. Registros antigos (UUID) continuam válidos.
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export const CHECK_ID_LENGTH = 12;
/** Mesmo alfabeto do gerador, em classe de caracteres. */
export const CHECK_ID_PATTERN = /^[0-9a-hjkmnp-tv-z]{12}$/;

/** 256 é múltiplo de 32: o resto não enviesa o sorteio. */
export function newCheckId(bytes = randomBytes(CHECK_ID_LENGTH)) {
  let id = "";
  for (let index = 0; index < CHECK_ID_LENGTH; index += 1) {
    id += ALPHABET[bytes[index] % ALPHABET.length];
  }
  return id;
}
