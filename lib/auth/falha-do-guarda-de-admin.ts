/**
 * A resposta de uma rota de API quando `requirePlatformAdmin()` recusa.
 *
 * `requirePlatformAdmin()` é o gate do layout de `/admin` e por isso RECUSA
 * REDIRECIONANDO (`redirect()` do Next lança um erro com `digest`). Rota de API
 * não pode devolver redirect de HTML a um consumidor de JSON: ela chama o gate
 * num `try/catch` e passa o erro para cá.
 *
 * Até aqui todo `catch` virava 403 `forbidden`, inclusive o redirect para a
 * prova do segundo fator — o cliente não tinha como distinguir "você não é
 * admin" de "confirme o código". Agora:
 *
 *  - redirect para a prova de MFA → 403 `mfa_required`;
 *  - qualquer outra coisa (sem sessão, sem linha em `platform_admins`, erro
 *    inesperado) → 403 `forbidden`, como antes.
 *
 * Mora FORA de `requirePlatformAdmin.ts` de propósito: os testes das rotas
 * trocam aquele módulo inteiro por um mock, e um export novo ali sumiria no
 * mock e derrubaria o `catch`.
 */
import { fail } from "@/lib/api/wrappers";
import { MENSAGEM_MFA_REQUIRED } from "@/lib/auth/garantia-da-sessao";

/** Para onde `requirePlatformAdmin()` manda quem precisa provar o segundo fator. */
export const ROTA_DA_PROVA_DE_MFA_DO_ADMIN = "/login/mfa?next=/admin";

/**
 * O destino de um erro de `redirect()` do Next, ou `null` se não for um.
 *
 * O formato do `digest` é o de `next/dist/client/components/redirect.js`
 * (`NEXT_REDIRECT;<tipo>;<url>;<status>;`), lido aqui sem importar o módulo
 * interno do Next.
 */
function destinoDoRedirect(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const digest = (err as { digest?: unknown }).digest;
  if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT;")) return null;
  return digest.split(";").slice(2, -2).join(";");
}

export function falhaDoGuardaDeAdmin(err: unknown, requestId?: string) {
  const destino = destinoDoRedirect(err);
  if (destino !== null && destino.startsWith("/login/mfa")) {
    return fail("mfa_required", MENSAGEM_MFA_REQUIRED, 403, { requestId });
  }
  return fail("forbidden", "Platform admin required", 403, { requestId });
}
