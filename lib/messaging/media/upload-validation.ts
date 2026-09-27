/** Validação do upload outbound (Onda 2). Allowlist por categoria + cap 50MB. */
import { posix } from "node:path";

import { MAX_MEDIA_BYTES } from "@/lib/messaging/media/types";

export type MessageKind = "image" | "video" | "audio" | "document";

/**
 * O caminho de Storage é uma chave LIMPA sob o prefixo? Compartilhado por quem
 * aceita caminho de fora (auditoria P2, `docs/imobiliario/04-…`).
 *
 * "Chaves do Storage são literais — sem semântica de traversal" era a premissa
 * daqui, e ela não se sustenta: o caminho atravessa URL (assinatura, download)
 * e um `org/conv/../../outraOrg/arquivo` passava no `startsWith` e podia
 * resolver fora do prefixo em quem normaliza no meio do caminho. A régua agora:
 *  - recusa `..`, `.` como segmento, `//`, `\`, `%` (codificação que alguém
 *    decodificaria DEPOIS desta conferência) e caractere de controle;
 *  - normaliza com `path.posix.normalize` e exige que o resultado seja IGUAL
 *    ao original — uma chave que muda ao normalizar não é uma chave limpa;
 *  - só então confere o prefixo.
 */
export function caminhoDeStorageDentroDe(caminho: string, prefixo: string): boolean {
  if (typeof caminho !== "string" || caminho.length === 0 || caminho.length > 500) return false;
  if (!prefixo.endsWith("/") || prefixo.length < 2) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\%]/.test(caminho)) return false;
  if (caminho.includes("//")) return false;
  if (caminho.startsWith("/")) return false;
  if (caminho.split("/").some((seg) => seg === ".." || seg === "." || seg === "")) return false;
  if (posix.normalize(caminho) !== caminho) return false;
  return caminho.startsWith(prefixo) && caminho.length > prefixo.length;
}

/**
 * Posse do objeto no bucket: o path DEVE estar sob {org}/{conversation}/, e
 * ser uma chave limpa (ver `caminhoDeStorageDentroDe`).
 *
 * Morava dentro do módulo de transporte do provider legado e não tinha nada a
 * ver com o canal: valida um path do NOSSO Storage, antes de qualquer coisa
 * tocar um provider. Ficar lá obrigava o handler de envio a importar do módulo
 * do provider — o acoplamento que o invariante 1 de
 * `docs/doctrine/restricao-de-canal.md` proíbe.
 */
export function isMediaPathOwnedBy(path: string, orgId: string, conversationId: string): boolean {
  if (!orgId || !conversationId) return false;
  return caminhoDeStorageDentroDe(path, `${orgId}/${conversationId}/`);
}

const DOCUMENT_MIMES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "application/zip",
]);

type Ok = { ok: true; kind: MessageKind };
type Fail = { ok: false; code: "unsupported_media_type" | "payload_too_large" | "validation_failed"; message: string };

export function validateOutboundMedia(mime: string, sizeBytes: number): Ok | Fail {
  if (!sizeBytes || sizeBytes <= 0) {
    return { ok: false, code: "validation_failed", message: "Arquivo vazio." };
  }
  if (sizeBytes > MAX_MEDIA_BYTES) {
    return { ok: false, code: "payload_too_large", message: "Arquivo acima de 50MB." };
  }
  const base = mime.split(";")[0]!.trim().toLowerCase();
  if (base.startsWith("image/")) return { ok: true, kind: "image" };
  if (base.startsWith("video/")) return { ok: true, kind: "video" };
  if (base.startsWith("audio/")) return { ok: true, kind: "audio" };
  if (DOCUMENT_MIMES.has(base)) return { ok: true, kind: "document" };
  return { ok: false, code: "unsupported_media_type", message: "Tipo de arquivo não suportado." };
}
