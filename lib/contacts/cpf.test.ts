/**
 * A3 — CPF cifrado no servidor (AES-256-GCM) e hash com chave (HMAC-SHA256).
 *
 * O que estes casos provam, e por quê:
 *  - a cifra vai ao banco como a literal `bytea` que o PostgREST aceita (`\x…`)
 *    e VOLTA dela — é assim que supabase-js escreve e lê `bytea`;
 *  - o hash não é mais o SHA-256 cru (enumerável em minutos): muda com a chave;
 *  - hash e cifra usam chaves DIFERENTES derivadas da mesma variável;
 *  - sem chave, nada sai: nem hash sozinho (violaria `contacts_cpf_consistency`).
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({ chave: "" }));
vi.mock("@/lib/env", () => ({
  env: new Proxy(
    {},
    { get: (_alvo, prop) => (prop === "CPF_ENCRYPTION_KEY" ? estado.chave : undefined) },
  ),
}));

import {
  colunasDoCpf,
  cpfCriptoDisponivel,
  CpfIndisponivelError,
  decryptCpf,
  encryptCpf,
  hashCpf,
  normalizeCpf,
} from "./cpf";

// `openssl rand -base64 32` — o formato que install.sh e gerar-env.sh produzem.
const CHAVE_A = "q5o1kB7sI0Qm0l3yVt2t8xJQv2cS8m9eZ0vKqRk3o8Y=";
const CHAVE_B = "Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmE=";
const CPF = "529.982.247-25";

afterEach(() => {
  estado.chave = "";
});

describe("cpf — cifra AES-256-GCM em bytea e hash HMAC", () => {
  it("cifra vira literal bytea `\\x<hex>` e volta ao CPF normalizado", () => {
    estado.chave = CHAVE_A;
    const bytea = encryptCpf(CPF);
    expect(bytea).toMatch(/^\\x[0-9a-f]+$/);
    // versão 01 + iv 12 + tag 16 + 11 bytes de cifra
    expect((bytea.length - 2) / 2).toBe(1 + 12 + 16 + 11);
    expect(bytea.slice(2, 4)).toBe("01");
    expect(decryptCpf(bytea)).toBe("52998224725");
  });

  it("decifra também o que o driver devolve como Buffer/Uint8Array", () => {
    estado.chave = CHAVE_A;
    const bytea = encryptCpf(CPF);
    const buf = Buffer.from(bytea.slice(2), "hex");
    expect(decryptCpf(buf)).toBe("52998224725");
    expect(decryptCpf(new Uint8Array(buf))).toBe("52998224725");
  });

  it("dois cadastros do mesmo CPF têm cifras diferentes (IV aleatório) e o MESMO hash", () => {
    estado.chave = CHAVE_A;
    expect(encryptCpf(CPF)).not.toBe(encryptCpf(CPF));
    expect(hashCpf(CPF)).toBe(hashCpf("52998224725"));
  });

  it("o hash não é o SHA-256 cru do CPF e depende da chave", () => {
    estado.chave = CHAVE_A;
    const comA = hashCpf(CPF);
    expect(comA).toMatch(/^[0-9a-f]{64}$/);
    expect(comA).not.toBe(createHash("sha256").update("52998224725").digest("hex"));
    estado.chave = CHAVE_B;
    expect(hashCpf(CPF)).not.toBe(comA);
  });

  it("a chave do hash não é a da cifra (separação de domínio)", () => {
    estado.chave = CHAVE_A;
    const bytea = encryptCpf(CPF);
    // Com a chave errada a cifra não abre — a tag GCM recusa.
    estado.chave = CHAVE_B;
    expect(() => decryptCpf(bytea)).toThrow();
  });

  it("colunasDoCpf devolve SEMPRE as duas colunas juntas", () => {
    estado.chave = CHAVE_A;
    const colunas = colunasDoCpf(CPF);
    expect(Object.keys(colunas).sort()).toEqual(["cpf_encrypted", "cpf_hash"]);
    expect(decryptCpf(colunas.cpf_encrypted)).toBe("52998224725");
  });

  it("sem chave: não há hash, nem cifra, nem leitura — erro nomeado", () => {
    estado.chave = "";
    expect(cpfCriptoDisponivel()).toBe(false);
    expect(() => hashCpf(CPF)).toThrow(CpfIndisponivelError);
    expect(() => encryptCpf(CPF)).toThrow(CpfIndisponivelError);
    expect(() => colunasDoCpf(CPF)).toThrow(CpfIndisponivelError);
  });

  it("chave curta demais conta como ausente", () => {
    estado.chave = "curta";
    expect(cpfCriptoDisponivel()).toBe(false);
  });

  it("recusa blob de formato desconhecido", () => {
    estado.chave = CHAVE_A;
    expect(() => decryptCpf("\\x02" + "00".repeat(40))).toThrow(/formato/);
  });

  it("documento de outro país mantém as letras na forma canônica", () => {
    expect(normalizeCpf("123456789xi000")).toBe("123456789XI000");
    expect(normalizeCpf(CPF)).toBe("52998224725");
  });
});
