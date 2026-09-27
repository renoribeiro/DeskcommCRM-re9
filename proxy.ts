import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { isPublicPath } from "@/lib/auth/public-paths";
import { safeNext } from "@/lib/auth/safe-next";
import {
  MENSAGEM_MFA_REQUIRED,
  sessaoDeveProvarSegundoFator,
  temFatorVerificado,
} from "@/lib/auth/garantia-da-sessao";
import { idDaRequisicao } from "@/lib/http/id-da-requisicao";
import { hstsDaInstalacao } from "@/lib/http/cabecalhos-de-seguranca";
import {
  verifyImpersonateCookieEdge,
  IMPERSONATE_COOKIE_NAME_EDGE,
} from "@/lib/impersonate/cookie-edge";

const COOKIE_NAME = "sb-deskcomm-auth";

/**
 * Caminhos NÃO públicos que uma sessão `aal1` com fator cadastrado ainda
 * alcança. Tudo de que a prova do segundo fator precisa já é público
 * (`/login/mfa`, `/login/recovery` e as server actions deles, que postam para
 * o próprio caminho da página); nenhuma rota de `/api/v1/auth/*` participa do
 * fluxo — a tela de MFA não monta o `AuthProvider`, então nem o
 * `realtime-token` é pedido ali. Fica só a tela de acesso revogado, cuja única
 * ação é sair.
 */
const LIVRES_DA_PROVA_DE_MFA: RegExp[] = [/^\/acesso-revogado$/];

export async function proxy(request: NextRequest) {
  // X-Request-Id: validado (ou gerado) e gravado nos cabeçalhos da REQUISIÇÃO
  // antes de criar a resposta. `NextResponse.next({ request: { headers } })`
  // copia os cabeçalhos no momento em que é chamado — o que se grava depois não
  // chega ao handler. Era o defeito: o id nunca alcançava rota nenhuma.
  const requestId = idDaRequisicao(request.headers.get("x-request-id"));
  const hsts = hstsDaInstalacao(env.NEXT_PUBLIC_APP_URL);
  // Toda resposta que sai daqui — seguir, redirecionar, 401, 403 — leva o id.
  const fim = <T extends NextResponse>(res: T): T => {
    res.headers.set("x-request-id", requestId);
    if (hsts) res.headers.set("Strict-Transport-Security", hsts);
    return res;
  };

  const { pathname, search } = request.nextUrl;
  // Recupera retornos de OAuth social já emitidos antes da landing pública existir.
  // Apenas a navegação é tratada: o vínculo de conta segue protegido pelos guards canônicos.
  // Passa adiante só o SINAL `connected=1` — nunca o `connect_token` nem o valor recebido.
  if (
    request.method === "GET" &&
    pathname === "/app/connections" &&
    request.nextUrl.searchParams.has("connected") &&
    request.nextUrl.searchParams.has("connect_token")
  ) {
    const landing = NextResponse.redirect(new URL("/auth/social-return?connected=1", request.url));
    landing.headers.set("Cache-Control", "no-store");
    landing.headers.set("Referrer-Policy", "no-referrer");
    return fim(landing);
  }

  // Expose pathname to Server Components via header (used by onboarding layout).
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);
  requestHeaders.set("x-pathname", pathname);
  const response = fim(NextResponse.next({ request: { headers: requestHeaders } }));
  response.headers.set("x-pathname", pathname);

  // EPIC-11: the admin surface is reached by PATH (`/admin/*`) — the self-host kit
  // points `NEXT_PUBLIC_ADMIN_URL` at the same host as the app and maps no `admin.`
  // sub-domain. The host-based branch below stays a NOOP today and only exists as
  // documentation of the intended deploy topology.
  const host = request.headers.get("host") ?? "";
  const isAdminSurface = host.startsWith("admin.") || pathname.startsWith("/admin");

  if (isPublicPath(pathname)) {
    return response;
  }

  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set(name, value);
            response.cookies.set(name, value, options);
          });
        },
      },
      cookieOptions: {
        name: COOKIE_NAME,
        sameSite: "strict",
        httpOnly: true,
        secure: cookieSecure(),
        path: "/",
      },
    },
  );

  // Validate JWT server-side (NEVER use getSession on backend per CLAUDE.md).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // API routes must respond with JSON envelope (contract: {error:{code,message}})
    // — never redirect HTML to JSON consumers. UI routes redirect to /login as before.
    if (pathname.startsWith("/api/")) {
      return fim(erroJson(401, "unauthenticated", "Authentication required"));
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname + search);
    return fim(NextResponse.redirect(loginUrl));
  }

  // MFA como política de SESSÃO na borda (W1). Quem tem fator verificado e
  // parou no passo do código tem uma sessão `aal1` com JWT válido — sem isto,
  // navegava em `/app` e pedia o token do Realtime só com a senha.
  //
  // Uma leitura só, e sem rede: `user.factors` já veio do `getUser()` acima (a
  // resposta do GoTrue, não a cópia do cookie) e `currentLevel` é o claim `aal`
  // do mesmo JWT. Por isso o `getAuthenticatorAssuranceLevel()` nem é chamado
  // para quem não tem fator — a maioria —, e o gate de CADASTRO
  // (`MfaEnrollGate`, dirigido pela política) segue intocado: ele trata quem
  // ainda NÃO tem fator, e esse nunca entra aqui.
  if (temFatorVerificado(user) && !LIVRES_DA_PROVA_DE_MFA.some((re) => re.test(pathname))) {
    const { data: aal, error: aalErr } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    const nivel = aalErr ? null : aal?.currentLevel;
    if (sessaoDeveProvarSegundoFator(user, nivel)) {
      // A resposta nova HERDA os cookies que o `getUser()` possa ter renovado:
      // perdê-los aqui deixaria o navegador com o refresh token já gasto, e a
      // tela de MFA abriria numa sessão que o GoTrue acabou de rotacionar.
      if (pathname.startsWith("/api/")) {
        return herdarCookies(fim(erroJson(403, "mfa_required", MENSAGEM_MFA_REQUIRED)), response);
      }
      const mfaUrl = new URL("/login/mfa", request.url);
      mfaUrl.searchParams.set("next", safeNext(pathname + search, "/app"));
      return herdarCookies(fim(NextResponse.redirect(mfaUrl)), response);
    }
  }

  // EPIC-11 S-11.07: validate impersonate cookie on /app/* paths. Middleware
  // runs in Edge — no DB access, only HMAC + expiry. On any failure we delete
  // the presentation cookie. The database support session remains authoritative:
  // expired/revoked support still blocks the app until explicit exit.
  if (pathname.startsWith("/app")) {
    const impCookie = request.cookies.get(IMPERSONATE_COOKIE_NAME_EDGE)?.value;
    if (impCookie) {
      const result = await verifyImpersonateCookieEdge(
        impCookie,
        env.IMPERSONATE_COOKIE_SECRET ?? "",
      );
      if (!result.valid) {
        console.warn(
          `[middleware] impersonate cookie invalid (${result.reason ?? "unknown"}) — clearing`,
        );
        response.cookies.delete(IMPERSONATE_COOKIE_NAME_EDGE);
      }
    }
  }

  // /admin/* additionally requires platform_admin (early gate — authoritative
  // check is server-side in `requirePlatformAdmin`). Skip the RPC for
  // `/admin/forbidden` (rendered to non-admins, would otherwise loop).
  if (isAdminSurface && pathname.startsWith("/admin") && pathname !== "/admin/forbidden") {
    const { data: isAdmin, error } = await supabase.rpc("fn_is_platform_admin");
    if (error || !isAdmin) {
      return fim(NextResponse.redirect(new URL("/admin/forbidden", request.url)));
    }
  }

  return response;
}

/**
 * O envelope de erro do contrato (`{ error: { code, message } }`, o mesmo de
 * `fail()` em `lib/api/wrappers.ts`). O `x-request-id` quem põe é `fim()`, com o
 * id do proxy — não um novo, como o `fail()` geraria sem `requestId`.
 */
function erroJson(status: number, code: string, message: string): NextResponse {
  return new NextResponse(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function herdarCookies(destino: NextResponse, origem: NextResponse): NextResponse {
  for (const cookie of origem.cookies.getAll()) destino.cookies.set(cookie);
  return destino;
}

export const config = {
  matcher: [
    // Run on all paths except static assets / Next internals.
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js)$).*)",
  ],
};
