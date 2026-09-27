/**
 * Cabeçalhos de segurança da aplicação — CSP e HSTS.
 *
 * ── CSP: só as diretivas que não quebram o Next ─────────────────────────────
 *
 * Um `script-src` sem nonce quebraria os scripts inline que o App Router
 * injeta (hidratação, `<PublicEnvScript/>`), então esta política NÃO restringe
 * script nem estilo. Ela fecha o que não custa nada ao produto:
 *
 *  - `frame-ancestors 'none'` — ninguém embute o CRM num iframe (clickjacking;
 *    o `X-Frame-Options: DENY` já dizia isso para navegadores antigos);
 *  - `base-uri 'self'` — um `<base>` injetado não reescreve os links relativos;
 *  - `object-src 'none'` — sem `<object>`/`<embed>` de plugin;
 *  - `form-action 'self'` — formulário não posta para outra origem. Os fluxos
 *    OAuth (Google, Meta, Google Ads, agenda, Nuvemshop) saem por
 *    `redirect`/link, nunca por `<form>` para fora — conferido no código em
 *    2026-09-27. A ponte `lib/auth/ponte-de-volta.ts` manda a própria CSP, mais
 *    estrita; o navegador aplica as duas (interseção), e nenhuma das diretivas
 *    daqui afrouxa a dela.
 *
 * É estática, então mora no `headers()` do `next.config.ts` (avaliado no build,
 * o que aqui não importa: nada nela depende da instalação).
 *
 * ── HSTS: depende da instalação, então NÃO mora no `next.config.ts` ──────────
 *
 * O `headers()` do `next.config.ts` é resolvido no BUILD, e a imagem é uma só
 * para todas as instalações (Dockerfile: `NEXT_PUBLIC_APP_URL` é placeholder no
 * build e o valor real chega em runtime). Decidir HSTS lá seria decidir pela URL
 * `https://placeholder.invalid`. Por isso o `proxy.ts` o emite em runtime, a
 * partir de `env.NEXT_PUBLIC_APP_URL` (lido do `process.env` em runtime por
 * `lib/env.ts`): só quando a instalação declara https.
 */

export const CONTENT_SECURITY_POLICY = [
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
].join("; ");

export const STRICT_TRANSPORT_SECURITY = "max-age=31536000; includeSubDomains";

/**
 * O valor de `Strict-Transport-Security` para esta instalação, ou `null`
 * quando ela não declara https (instalação por IP/porta, dev local) — mandar
 * HSTS ali prenderia o navegador num https que não existe.
 */
export function hstsDaInstalacao(appUrl: string | null | undefined): string | null {
  const url = (appUrl ?? "").trim().toLowerCase();
  return url.startsWith("https://") ? STRICT_TRANSPORT_SECURITY : null;
}
