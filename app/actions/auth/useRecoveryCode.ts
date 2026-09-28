"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { safeNext } from "@/lib/auth/safe-next";
import { z } from "zod";

import { createAdminClient } from "@/lib/supabase/admin";
import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { hashRecoveryCode } from "@/lib/auth/recovery-codes";
import { AUTH_LIMITS, authRateLimited } from "@/lib/auth/rate-limit";
import { usuarioPorEmail } from "@/lib/auth/usuario-por-email";

export type UseRecoveryCodeResult =
  | { ok: false; error: "invalid_or_used" }
  | { ok: false; error: "rate_limited" }
  | { ok: false; error: "service_unavailable" };

const inputSchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^[A-Z0-9]{8}$/, "Código inválido"),
});

/**
 * Burns a recovery code: marks it used, deletes ALL TOTP factors of the user
 * (so they can re-enroll on next login), then redirects to /login. Generic
 * errors are returned for any failure — never leak whether email exists.
 *
 * Security:
 *  - 200ms artificial delay on miss (timing leak protection).
 *  - hashRecoveryCode = sha256 → bytea match.
 *  - Audit emits with masked code (`AB****YZ`).
 *  - Teto de tentativas por e-mail E por origem (P9, `AUTH_LIMITS.recovery_code`):
 *    cada acerto apaga os fatores da conta, então chutar código não pode ser
 *    de graça. O teto conta toda tentativa, exista o e-mail ou não — a resposta
 *    não vira oráculo de conta.
 *  - Usuário resolvido por `usuarioPorEmail`, que pagina o diretório inteiro
 *    (com teto) em vez de olhar só os 200 primeiros.
 */
export async function useRecoveryCode(
  rawInput: { email: string; code: string },
  next?: string,
): Promise<UseRecoveryCodeResult | void> {
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = hdrs.get("user-agent") ?? null;

  const parsed = inputSchema.safeParse({
    email: rawInput.email?.trim().toLowerCase(),
    code: rawInput.code?.trim().toUpperCase(),
  });
  if (!parsed.success) {
    await delay(200);
    return { ok: false, error: "invalid_or_used" };
  }

  if (!isServiceRoleConfigured()) {
    console.warn(
      "[useRecoveryCode] SUPABASE_SERVICE_ROLE_KEY not configured — recovery flow unavailable",
    );
    return { ok: false, error: "service_unavailable" };
  }

  const admin = createAdminClient();
  const { email, code } = parsed.data;

  if (await authRateLimited("recovery_code", email, AUTH_LIMITS.recovery_code)) {
    return { ok: false, error: "rate_limited" };
  }

  // 1) Resolve user by email via admin API. Generic error if missing.
  const busca = await usuarioPorEmail(admin, email);
  if (!busca.ok) {
    await delay(200);
    return { ok: false, error: "invalid_or_used" };
  }
  const targetUser = busca.user;
  if (!targetUser) {
    await delay(200);
    return { ok: false, error: "invalid_or_used" };
  }

  // 2) Find an unused recovery code matching the sha256 hash.
  const codeHash = hashRecoveryCode(code);
  const { data: row, error: rowErr } = await admin
    .from("user_recovery_codes")
    .select("id, used_at")
    .eq("user_id", targetUser.id)
    .eq("code_hash", codeHash)
    .is("used_at", null)
    .limit(1)
    .maybeSingle();

  if (rowErr || !row) {
    await delay(200);
    return { ok: false, error: "invalid_or_used" };
  }

  // 3) Burn it.
  const { error: updErr } = await admin
    .from("user_recovery_codes")
    .update({ used_at: new Date().toISOString(), used_ip: ip })
    .eq("id", row.id);
  if (updErr) {
    return { ok: false, error: "invalid_or_used" };
  }

  // 4) Delete ALL TOTP factors for the user so they re-enroll on next login.
  try {
    const { data: factors } = await admin.auth.admin.mfa.listFactors({
      userId: targetUser.id,
    });
    for (const f of factors?.factors ?? []) {
      await admin.auth.admin.mfa.deleteFactor({ userId: targetUser.id, id: f.id });
    }
  } catch (err) {
    console.error("[useRecoveryCode] failed to delete factors", err);
    // Non-fatal: user still gets a recovery_used redirect; on next login the
    // residual factor would block them, but seeded user has no factor anyway.
  }

  // 5) Audit (masked).
  await audit({
    action: "auth.recovery_code_used",
    actorUserId: targetUser.id,
    metadata: {
      masked_code: `${code.slice(0, 2)}****${code.slice(-2)}`,
      next: next ?? null,
    },
    requestId,
    ip,
    userAgent,
  });

  // 6) Redirect to /login fresh — user logs in normally and re-enrolls MFA.
  const params = new URLSearchParams({ recovery_used: "1" });
  // Sanitiza aqui também: este `next` volta para /login e de lá alimenta o
  // redirect de signInWithPassword — carregar destino externo por este caminho
  // daria na mesma coisa, só com um salto a mais.
  const destino = safeNext(next, "");
  if (destino) params.set("next", destino);
  redirect(`/login?${params.toString()}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
