/**
 * Server guard for /admin/* (Super-Admin Platform sub-product).
 *
 * Flow:
 *  1. Validate JWT via getUser() (NEVER getSession on backend per CLAUDE.md).
 *  2. Confirm row in platform_admins (active = no revoked_at).
 *  3. Enforce MFA AAL2 when `mfa_required` OR the admin has a verified factor.
 *
 * Redirects:
 *  - no user        → /login?next=/admin
 *  - no row         → /admin/forbidden
 *  - aal1 + (required OR has factor) → /login/mfa?next=/admin
 *
 * ⚠️ ROTAS DE API não podem devolver o redirect: elas chamam isto dentro de um
 * `try/catch` e respondem com `falhaDoGuardaDeAdmin(err, requestId)`
 * (`lib/auth/falha-do-guarda-de-admin.ts`), que traduz o redirect para
 * `/login/mfa` em 403 `mfa_required` e qualquer outra falha em 403 `forbidden`.
 *
 * "TEM FATOR" É A PERGUNTA "PROVAR" da doutrina (CLAUDE.md): `mfa_required` é
 * política de CADASTRO, e sozinha deixava o admin que ativou o TOTP por vontade
 * própria operar as rotas da plataforma com a sessão `aal1` — só com a senha.
 * O fator vem do `user.factors` do `getUser()` (resposta do GoTrue), nunca do
 * `nextLevel`, que é calculado da cópia do usuário no cookie.
 *
 * The middleware already does an early `fn_is_platform_admin` RPC check;
 * this helper performs the authoritative server-side validation inside the
 * /admin layout (where redirects are cheap, DB calls are allowed in Node
 * runtime, and we have access to AAL state).
 */
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { temFatorVerificado } from "@/lib/auth/garantia-da-sessao";
import { ROTA_DA_PROVA_DE_MFA_DO_ADMIN } from "@/lib/auth/falha-do-guarda-de-admin";

export interface PlatformAdminInfo {
  user_id: string;
  scope: string;
  mfa_required: boolean;
}

export interface PlatformAdminContext {
  user: User;
  platformAdmin: PlatformAdminInfo;
}

export async function requirePlatformAdmin(): Promise<PlatformAdminContext> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login?next=/admin");
  }

  // platform_admins RLS: only platform admins read; non-admins get null → forbid.
  const { data: paRow } = await supabase
    .from("platform_admins")
    .select("user_id, scope, mfa_required, revoked_at")
    .eq("user_id", user.id)
    .is("revoked_at", null)
    .maybeSingle();

  if (!paRow) {
    redirect("/admin/forbidden");
  }

  if (paRow.mfa_required || temFatorVerificado(user)) {
    const { data: aalData, error: aalErr } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    // Falha fechada: leitura com erro não prova nada.
    if (aalErr || aalData?.currentLevel !== "aal2") {
      redirect(ROTA_DA_PROVA_DE_MFA_DO_ADMIN);
    }
  }

  return {
    user,
    platformAdmin: {
      user_id: paRow.user_id,
      scope: paRow.scope,
      mfa_required: paRow.mfa_required,
    },
  };
}
