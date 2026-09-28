/**
 * AES-256-GCM helpers para `ai_provider_credentials`.
 *
 * Key source: `process.env.AI_CRED_AES_KEY` — 32 bytes em base64.
 * Output do `encryptKey`: três `Buffer`s separados (ciphertext, IV de 12 bytes,
 * tag de 16 bytes) que são gravados como `bytea` na tabela. Pra uso via PostgREST
 * use o helper `bufToBytea()` que produz a literal `\x<hex>`.
 *
 * Plaintext NUNCA deve ser logado, persistido ou retornado em response — apenas
 * o `last4` é exposto via view `ai_provider_credentials_safe`.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { env } from "@/lib/env";

const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const TAG_LENGTH_BYTES = 16;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = env.AI_CRED_AES_KEY;
  if (!raw) {
    throw new Error(
      "AI_CRED_AES_KEY não configurada. Defina em .env.local (32 bytes base64).",
    );
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, "base64");
  } catch {
    throw new Error("AI_CRED_AES_KEY inválida: base64 malformado.");
  }
  if (buf.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `AI_CRED_AES_KEY deve ter exatamente 32 bytes (lido: ${buf.length}). Gere com: openssl rand -base64 32`,
    );
  }
  cachedKey = buf;
  return buf;
}

export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  /** Últimos 4 chars do plaintext, mostrados na UI pra identificação. */
  last4: string;
}

export function encryptKey(plaintext: string): EncryptedSecret {
  if (!plaintext || typeof plaintext !== "string") {
    throw new Error("plaintext inválido pra encryptKey()");
  }
  const { ciphertext, iv, tag } = encryptWithKey(getKey(), plaintext);
  const last4 = plaintext.slice(-4);
  return { ciphertext, iv, tag, last4 };
}

export function decryptKey(input: {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}): string {
  return decryptWithKey(getKey(), input);
}

/**
 * Cifra com uma chave explícita de 32 bytes (AES-256-GCM, IV aleatório de 12
 * bytes, tag de 16). É o miolo de `encryptKey`, exposto para quem tem chave
 * própria — o CPF (`lib/contacts/cpf.ts`) usa a `CPF_ENCRYPTION_KEY`, nunca a
 * das credenciais de IA.
 */
export function encryptWithKey(
  key: Buffer,
  plaintext: string,
): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(`chave AES-256 deve ter ${KEY_LENGTH_BYTES} bytes (lido: ${key.length})`);
  }
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LENGTH_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_LENGTH_BYTES) {
    throw new Error(`tag length inesperada: ${tag.length}`);
  }
  return { ciphertext, iv, tag };
}

/**
 * Decifra conferindo o TAMANHO do IV e da tag antes de tocar no decipher.
 *
 * Sem `authTagLength`, o Node aceita tag truncada (4, 8, 12… bytes) em GCM: a
 * autenticação passa a valer 32 bits em vez de 128, e um adulterador que
 * controle o `bytea` tenta 2^32 em vez de 2^128. O tamanho do IV também é fixo
 * aqui (12): um IV de outro tamanho não é defeito que se decifra "por sorte",
 * é dado corrompido ou forjado.
 */
export function decryptWithKey(
  key: Buffer,
  input: { ciphertext: Buffer; iv: Buffer; tag: Buffer },
): string {
  const { ciphertext, iv, tag } = input;
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(`chave AES-256 deve ter ${KEY_LENGTH_BYTES} bytes (lido: ${key.length})`);
  }
  if (iv.length !== IV_LENGTH_BYTES) {
    throw new Error(`IV com tamanho inválido: ${iv.length} (esperado ${IV_LENGTH_BYTES})`);
  }
  if (tag.length !== TAG_LENGTH_BYTES) {
    throw new Error(`tag com tamanho inválido: ${tag.length} (esperado ${TAG_LENGTH_BYTES})`);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LENGTH_BYTES });
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

/**
 * Converte um Buffer em literal hex aceito pelo PostgREST pra colunas `bytea`.
 */
export function bufToBytea(buf: Buffer): string {
  return `\\x${buf.toString("hex")}`;
}

/**
 * Inverso de `bufToBytea`: aceita o que o PostgREST devolve em colunas bytea
 * (string `\xHEX` em modo padrão, ou Buffer/Uint8Array dependendo do driver).
 */
export function byteaToBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") {
    const hex = value.startsWith("\\x") ? value.slice(2) : value;
    return Buffer.from(hex, "hex");
  }
  throw new Error("byteaToBuffer: formato inesperado");
}
