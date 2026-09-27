/**
 * CPF: normalização, cifragem em repouso e hash de busca — tudo no servidor Node.
 *
 * Por que aqui e não no banco: o código chamava as RPCs `encrypt_cpf` e
 * `decrypt_cpf`, que NUNCA existiram no schema. Sem a cifra, o insert levava só
 * `cpf_hash`, e o CHECK `contacts_cpf_consistency` (os dois nulos ou os dois
 * preenchidos) recusava a linha — cadastrar contato com CPF falhava sempre.
 *
 * O que vale agora:
 *
 * - `cpf_encrypted` (bytea) = AES-256-GCM com chave derivada da
 *   `CPF_ENCRYPTION_KEY`. Formato do blob: `0x01 ‖ iv(12) ‖ tag(16) ‖ cifra`.
 *   O byte de versão permite trocar o esquema sem adivinhar o formato.
 * - `cpf_hash` (text) = HMAC-SHA256 do CPF normalizado com OUTRA chave derivada
 *   da mesma `CPF_ENCRYPTION_KEY`. O SHA-256 puro de antes era reversível em
 *   minutos: são só 10^9 CPFs válidos, e sem chave o espaço inteiro se enumera
 *   numa GPU comum. Com HMAC, quem lê o banco sem a chave não enumera nada.
 * - As duas chaves saem por HKDF com rótulos distintos (separação de domínio):
 *   vazar a chave de busca não entrega a de cifra, e vice-versa.
 *
 * Sem chave configurada, NENHUMA escrita de CPF acontece: `CpfIndisponivelError`
 * vira 503 `cpf_encryption_unavailable` no chamador. Gravar só o hash violaria
 * o CHECK e, pior, prometeria um CPF que ninguém consegue recuperar.
 *
 * O PostgREST fala `bytea` como texto `\x<hex>` nas duas direções — é isso que
 * `encryptCpf` devolve e o que `decryptCpf` aceita (além de Buffer/Uint8Array).
 *
 * Nunca logue o CPF, a cifra nem as chaves.
 */
import { createHmac, hkdfSync } from "node:crypto";

import {
  bufToBytea,
  byteaToBuffer,
  decryptWithKey,
  encryptWithKey,
} from "@/lib/crypto/aes_gcm";
import { env } from "@/lib/env";

const VERSAO_DO_BLOB = 0x01;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Material mínimo aceito: abaixo disso a chave é erro de configuração, não chave. */
const MATERIAL_MINIMO_BYTES = 16;

const ROTULO_CIFRA = "deskcomm/contacts/cpf/aes-256-gcm/v1";
const ROTULO_HASH = "deskcomm/contacts/cpf/hmac-sha256/v1";

/** Recusa de escrita/leitura de CPF por falta (ou defeito) da `CPF_ENCRYPTION_KEY`. */
export class CpfIndisponivelError extends Error {
  constructor(message = "CPF_ENCRYPTION_KEY ausente ou inválida — CPF não pode ser gravado nem lido.") {
    super(message);
    this.name = "CpfIndisponivelError";
  }
}

/**
 * Forma canônica do documento: só letras e dígitos, letras em maiúsculas.
 *
 * Para o CPF brasileiro é exatamente "só os 11 dígitos". A versão anterior
 * (`\D` → "") também apagava as LETRAS de documento de outro país (issue
 * #1033: o perfil do país pode aceitar `123456789XI000`), e dois documentos
 * que só diferem nas letras colidiam no mesmo hash.
 */
export function normalizeCpf(raw: string): string {
  return raw.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

/**
 * O material da chave. `openssl rand -base64 32` (o que o install.sh gera) é
 * decodificado; qualquer outra string com entropia suficiente é usada como
 * bytes UTF-8 — o HKDF adiante normaliza o tamanho. O que não passa é chave
 * vazia ou curta demais.
 */
function materialDaChave(bruta: string | undefined): Buffer | null {
  const valor = (bruta ?? "").trim();
  if (!valor) return null;
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(valor) && valor.length % 4 === 0) {
    const decodificada = Buffer.from(valor, "base64");
    if (decodificada.length >= 32) return decodificada;
  }
  const utf8 = Buffer.from(valor, "utf8");
  return utf8.length >= MATERIAL_MINIMO_BYTES ? utf8 : null;
}

interface ChavesDoCpf {
  cifra: Buffer;
  hash: Buffer;
}

let cache: { bruta: string; chaves: ChavesDoCpf | null } | null = null;

function chaves(): ChavesDoCpf | null {
  const bruta = env.CPF_ENCRYPTION_KEY ?? "";
  if (cache && cache.bruta === bruta) return cache.chaves;
  const material = materialDaChave(bruta);
  const derivadas = material
    ? {
        cifra: Buffer.from(hkdfSync("sha256", material, Buffer.alloc(0), ROTULO_CIFRA, 32)),
        hash: Buffer.from(hkdfSync("sha256", material, Buffer.alloc(0), ROTULO_HASH, 32)),
      }
    : null;
  cache = { bruta, chaves: derivadas };
  return derivadas;
}

function chavesOuFalha(): ChavesDoCpf {
  const c = chaves();
  if (!c) throw new CpfIndisponivelError();
  return c;
}

/** A instalação tem chave para gravar/ler CPF? */
export function cpfCriptoDisponivel(): boolean {
  return chaves() !== null;
}

/**
 * HMAC-SHA256 (hex) do CPF normalizado — busca exata e dedup sem expor o CPF.
 * Lança `CpfIndisponivelError` sem chave.
 */
export function hashCpf(raw: string): string {
  return createHmac("sha256", chavesOuFalha().hash).update(normalizeCpf(raw)).digest("hex");
}

/** Cifra o CPF normalizado e devolve a literal `bytea` do PostgREST (`\x…`). */
export function encryptCpf(raw: string): string {
  const { ciphertext, iv, tag } = encryptWithKey(chavesOuFalha().cifra, normalizeCpf(raw));
  return bufToBytea(Buffer.concat([Buffer.from([VERSAO_DO_BLOB]), iv, tag, ciphertext]));
}

/** Decifra o que o PostgREST devolve em `cpf_encrypted` (`\x…`, Buffer ou Uint8Array). */
export function decryptCpf(valor: unknown): string {
  const blob = byteaToBuffer(valor);
  if (blob.length < 1 + IV_BYTES + TAG_BYTES + 1 || blob[0] !== VERSAO_DO_BLOB) {
    throw new Error("cpf_encrypted em formato desconhecido");
  }
  const iv = blob.subarray(1, 1 + IV_BYTES);
  const tag = blob.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(1 + IV_BYTES + TAG_BYTES);
  return decryptWithKey(chavesOuFalha().cifra, { ciphertext, iv, tag });
}

/**
 * As DUAS colunas juntas, sempre — é o que o CHECK `contacts_cpf_consistency`
 * exige. Não há caminho que devolva só uma.
 */
export function colunasDoCpf(raw: string): { cpf_hash: string; cpf_encrypted: string } {
  return { cpf_hash: hashCpf(raw), cpf_encrypted: encryptCpf(raw) };
}
