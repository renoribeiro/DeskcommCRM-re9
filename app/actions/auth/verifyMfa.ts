"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { safeNext } from "@/lib/auth/safe-next";

import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import {
  AUTH_LIMITS,
  authRateLimited,
  mfaBloqueadoPorFalhas,
  registrarFalhaDeMfa,
} from "@/lib/auth/rate-limit";

export type VerifyMfaResult =
  | { ok: false; error: "mfa_invalid" }
  | { ok: false; error: "mfa_locked"; retry_in_seconds: number };

const ATTEMPT_COOKIE = "mfa_attempts";
const ATTEMPT_TTL_SECONDS = 60;
const MAX_ATTEMPTS = 3;

/**
 * Verifies a TOTP code against the user's verified factor and (on success)
 * elevates the session to AAL2.
 *
 * Limite de tentativas (P6): o que vale é o contador POR CONTA no Redis
 * (`mfaBloqueadoPorFalhas` / `registrarFalhaDeMfa` em `lib/auth/rate-limit.ts`:
 * 3 falhas/60 s e 10 falhas/1 h), mais um teto por origem
 * (`authRateLimited("mfa_verify")`). O cookie `mfa_attempts` continua como
 * atalho de UX no mesmo navegador, mas deixou de ser a garantia — o usuário
 * apaga o cookie, não apaga o Redis.
 */
export async function verifyMfa(code: string, next?: string): Promise<VerifyMfaResult> {
  const supabase = await createClient();
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = hdrs.get("user-agent") ?? null;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Sanity-check: must have a verified TOTP factor.
  const { data: factorsData } = await supabase.auth.mfa.listFactors();
  const totp = factorsData?.totp?.find((f) => f.status === "verified");
  if (!totp) redirect("/app");

  // Lockout check (cookie counter).
  const store = await cookies();
  const raw = store.get(ATTEMPT_COOKIE)?.value;
  let attempts = 0;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed)) attempts = parsed;
  }
  if (attempts >= MAX_ATTEMPTS) {
    return { ok: false, error: "mfa_locked", retry_in_seconds: ATTEMPT_TTL_SECONDS };
  }

  const esperaDaConta = await mfaBloqueadoPorFalhas(user.id);
  if (esperaDaConta !== null) {
    return { ok: false, error: "mfa_locked", retry_in_seconds: esperaDaConta };
  }
  if (await authRateLimited("mfa_verify", null, AUTH_LIMITS.mfa_verify)) {
    return { ok: false, error: "mfa_locked", retry_in_seconds: AUTH_LIMITS.mfa_verify.windowSec };
  }

  if (!/^\d{6}$/.test(code)) {
    return { ok: false, error: "mfa_invalid" };
  }

  // Issue challenge + verify.
  const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({
    factorId: totp.id,
  });
  if (challengeErr || !challenge) {
    return { ok: false, error: "mfa_invalid" };
  }

  const { error: verifyErr } = await supabase.auth.mfa.verify({
    factorId: totp.id,
    challengeId: challenge.id,
    code,
  });

  if (verifyErr) {
    const newAttempts = attempts + 1;
    store.set(ATTEMPT_COOKIE, String(newAttempts), {
      httpOnly: true,
      sameSite: "strict",
      secure: cookieSecure(),
      maxAge: ATTEMPT_TTL_SECONDS,
      path: "/",
    });
    const esperaAgora = await registrarFalhaDeMfa(user.id);
    const locked = newAttempts >= MAX_ATTEMPTS || esperaAgora !== null;
    const retryInSeconds = Math.max(esperaAgora ?? 0, ATTEMPT_TTL_SECONDS);
    await audit({
      action: "auth.mfa_failed",
      actorUserId: user.id,
      metadata: { locked, attempts: newAttempts },
      requestId,
      ip,
      userAgent,
    });
    if (locked) {
      return { ok: false, error: "mfa_locked", retry_in_seconds: retryInSeconds };
    }
    return { ok: false, error: "mfa_invalid" };
  }

  // Reset attempt counter and audit success.
  store.delete(ATTEMPT_COOKIE);
  await audit({
    action: "auth.mfa_success",
    actorUserId: user.id,
    metadata: {},
    requestId,
    ip,
    userAgent,
  });

  redirect(safeNext(next, "/app"));
}
