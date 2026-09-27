/**
 * A9 — o AES-GCM confere o tamanho do IV e da tag ao decifrar.
 *
 * O caso que importa é a tag TRUNCADA: sem `authTagLength`, o Node aceita
 * uma tag de 12 (ou 4, 8…) bytes em GCM e confere só o prefixo — a
 * autenticação cai de 128 para 96 (ou 32) bits sem ninguém ver.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { decryptWithKey, encryptWithKey } from "./aes_gcm";

const CHAVE = randomBytes(32);

describe("aes_gcm — decifrar exige IV de 12 e tag de 16 bytes", () => {
  it("ida e volta com a chave explícita", () => {
    const cifrado = encryptWithKey(CHAVE, "segredo-123");
    expect(cifrado.iv.length).toBe(12);
    expect(cifrado.tag.length).toBe(16);
    expect(decryptWithKey(CHAVE, cifrado)).toBe("segredo-123");
  });

  it("recusa tag truncada que o GCM do Node aceitaria (prefixo verdadeiro de 12 bytes)", () => {
    const cifrado = encryptWithKey(CHAVE, "segredo-123");
    const truncada = cifrado.tag.subarray(0, 12);
    expect(() => decryptWithKey(CHAVE, { ...cifrado, tag: truncada })).toThrow(/tag/);
  });

  it("recusa tag de 4 bytes", () => {
    const cifrado = encryptWithKey(CHAVE, "x");
    expect(() => decryptWithKey(CHAVE, { ...cifrado, tag: cifrado.tag.subarray(0, 4) })).toThrow(
      /tag/,
    );
  });

  it("recusa IV de tamanho diferente de 12", () => {
    const cifrado = encryptWithKey(CHAVE, "x");
    expect(() =>
      decryptWithKey(CHAVE, { ...cifrado, iv: Buffer.concat([cifrado.iv, Buffer.from([0])]) }),
    ).toThrow(/IV/);
    expect(() => decryptWithKey(CHAVE, { ...cifrado, iv: cifrado.iv.subarray(0, 8) })).toThrow(
      /IV/,
    );
  });

  it("tag adulterada com o tamanho certo continua recusada pelo GCM", () => {
    const cifrado = encryptWithKey(CHAVE, "x");
    const tag = Buffer.from(cifrado.tag);
    tag[0] = (tag[0] ?? 0) ^ 0xff;
    expect(() => decryptWithKey(CHAVE, { ...cifrado, tag })).toThrow();
  });

  it("recusa chave que não tem 32 bytes", () => {
    expect(() => encryptWithKey(randomBytes(16), "x")).toThrow(/32 bytes/);
  });
});
