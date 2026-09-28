/**
 * Stateless HMAC-SHA256 invite token. Self-contained payload, signed and
 * base64url-encoded — no DB row required to issue. Verified at accept time.
 *
 * Format: `<body>.<sig>` where
 *   - body = base64url(JSON({invite_id, email, organization_id, role, exp}))
 *   - sig  = base64url(HMAC_SHA256(chave, body))
 *
 * ## A chave é DERIVADA, e a falta dela FECHA
 *
 * A chave é `HMAC-SHA256(segredo, "crm:invite-token:v1")`, com o segredo em
 * `INVITE_TOKEN_SECRET` ou, sem ele, `INTERNAL_SECRET` — o mesmo padrão de
 * `lib/auth/chave-do-estado-oauth.ts`, com outro rótulo. Antes o token era
 * assinado com o `INTERNAL_SECRET` CRU, que também é o bearer dos crons e que
 * o runbook do relógio HTTP manda cadastrar num serviço de terceiros: quem
 * visse aquele bearer forjava convite de `admin` para qualquer organização.
 * A derivação separa DOMÍNIOS, mas não protege contra esse vazamento: o rótulo
 * é público, e quem tem o `INTERNAL_SECRET` calcula a mesma chave. O que
 * protege é o `INVITE_TOKEN_SECRET` próprio — o `gerar-env.sh` do Dokploy o
 * gera — e o runbook do relógio usar `INTERNAL_CRON_SECRET`, nunca o
 * `INTERNAL_SECRET`.
 *
 * E faltava fechar: sem segredo, a assinatura caía em `"dev-fallback"` — uma
 * chave pública, escrita neste arquivo. Agora, sem segredo, assinar e conferir
 * LANÇAM, fora do ambiente de teste (`NODE_ENV=test`), que usa uma chave fixa e
 * declaradamente só de teste. Segredo vazio conta como ausente: o `.env.example`
 * entrega `INTERNAL_SECRET=` e, em desenvolvimento, `lib/env.ts` o aceita vazio.
 *
 * O rótulo não leva o nome do produto de propósito: o produto é revendido com
 * outra marca (`tests/unit/branding.test.ts`). Troca de rótulo ou de segredo
 * invalida os convites pendentes (valem 24 h): quem não aceitou recebe outro.
 *
 * Verification uses `timingSafeEqual` to avoid timing oracles.
 */
import { z } from "zod";
import { interfaceSettingsSchema, type InterfaceSettings } from "@/lib/navigation/interface";
import { createHmac, timingSafeEqual } from "node:crypto";

export const ROTULO_DA_CHAVE_DO_CONVITE = "crm:invite-token:v1";

/** Segredo SÓ do ambiente de teste (`NODE_ENV=test`), nunca alcançável em produção. */
const SEGREDO_SO_DE_TESTE = "somente-teste:convite-sem-segredo";

export class ConviteSemSegredoError extends Error {
  constructor() {
    super(
      "invite_token_sem_segredo: defina INTERNAL_SECRET (ou INVITE_TOKEN_SECRET) para assinar e conferir convites",
    );
    this.name = "ConviteSemSegredoError";
  }
}

/** A chave de assinatura dos convites, derivada do segredo mestre. */
export function chaveDoConvite(segredoMestre: string): Buffer {
  return createHmac("sha256", segredoMestre).update(ROTULO_DA_CHAVE_DO_CONVITE, "utf8").digest();
}

function chaveEmVigor(): Buffer {
  const mestre =
    (process.env.INVITE_TOKEN_SECRET ?? "").trim() || (process.env.INTERNAL_SECRET ?? "").trim();
  if (mestre) return chaveDoConvite(mestre);
  if (process.env.NODE_ENV === "test") return chaveDoConvite(SEGREDO_SO_DE_TESTE);
  throw new ConviteSemSegredoError();
}

export interface InvitePayload {
  interface_settings?: InterfaceSettings;
  invite_id: string;
  email: string;
  organization_id: string;
  role: string;
  exp: number; // epoch seconds
  iat?: number;
  invited_by?: string;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function signInviteToken(payload: InvitePayload): string {
  const json = JSON.stringify(payload);
  const body = b64url(Buffer.from(json, "utf8"));
  const sig = b64url(createHmac("sha256", chaveEmVigor()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyInviteToken(token: string): InvitePayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;

  const expected = b64url(createHmac("sha256", chaveEmVigor()).update(body).digest());
  if (sig.length !== expected.length) return null;

  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }

  let payload: InvitePayload;
  try {
    const json = Buffer.from(body, "base64url").toString("utf8");
    payload = JSON.parse(json) as InvitePayload;
  } catch {
    return null;
  }

  const checked = z
    .object({
      invite_id: z.string().uuid(),
      email: z.string().email(),
      organization_id: z.string().uuid(),
      role: z.enum(["viewer", "agent", "manager", "admin"]),
      exp: z.number().int().positive(),
      iat: z.number().int().positive().optional(),
      invited_by: z.string().uuid().optional(),
      interface_settings: interfaceSettingsSchema.optional(),
    })
    .safeParse(payload);
  if (!checked.success) return null;
  payload = checked.data;

  if (payload.exp * 1000 < Date.now()) return null;
  return payload;
}

export const INVITE_TTL_SECONDS = 60 * 60 * 24; // 24h
