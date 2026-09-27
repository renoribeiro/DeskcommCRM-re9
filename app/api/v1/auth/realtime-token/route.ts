/**
 * GET /api/v1/auth/realtime-token — o token que o canal Realtime precisa.
 *
 * Por que existe: o cookie de sessão é httpOnly (CLAUDE.md), então o
 * supabase-js do browser NÃO enxerga a sessão e assina os canais como ANÔNIMO.
 * O Realtime aplica RLS por canal: canal anônimo assina, recebe "ok", e nunca
 * recebe evento nenhum — falha silenciosa que parece saúde. O fetch do board já
 * tinha sido movido para rota de API por essa mesma razão (ver useBoard);
 * o realtime ficou para trás.
 *
 * A sessão continua morando no cookie httpOnly. Isto entrega apenas o
 * access_token, em memória, para o cliente autenticar o WebSocket — nunca
 * gravado em storage, e some no reload.
 *
 * NÃO ESTENDA ESTE ENDPOINT. Ele existe para UM consumidor: o socket do
 * Realtime. Precisa de token no browser para outra coisa? A resposta certa é
 * rota de API no servidor, não mais um campo aqui — senão a exceção vira porta.
 *
 * `cache-control: no-store` é obrigatório e não é zelo abstrato: o corpo de
 * sucesso É um token de sessão, e o deploy tem Caddy na frente. Um 200 cacheado
 * serviria o token de um usuário para outro. O repo já decidiu isso duas vezes
 * para carga MENOS sensível — as rotas de QR (`channel-sessions/[id]/qr`,
 * `onboarding/whatsapp/qr`) setam no-store porque um QR é segredo.
 *
 * O TOKEN SÓ SAI DE SESSÃO QUE PROVOU O SEGUNDO FATOR, quando há fator (W5). O
 * corpo É um JWT de sessão: entregá-lo a uma sessão `aal1` de quem tem TOTP
 * cadastrado seria dar a quem só tem a senha um token para ler o banco pelo
 * Realtime e pela REST. O `proxy.ts` já barra esse caso na borda; a checagem
 * aqui é a mesma regra (`sessaoDeveProvarSegundoFator`), porque a garantia de
 * uma rota que entrega credencial não pode morar num único lugar.
 *
 * Com teto por usuário: o cliente guarda o token em memória até perto de
 * vencer e coalesce os pedidos (`lib/supabase/browser.ts`), então o uso normal
 * é um pedido por aba carregada. O teto só pega laço ou abuso.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { MENSAGEM_MFA_REQUIRED, sessaoDeveProvarSegundoFator } from "@/lib/auth/garantia-da-sessao";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store, max-age=0" } as const;

/** Pedidos por usuário por janela. Uso normal: um por aba carregada. */
const TETO_POR_USUARIO = 60;
const JANELA_SEGUNDOS = 60;

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  // getUser() valida o JWT no servidor — é ele que autoriza a resposta.
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId, headers: NO_STORE });
  }

  // PROVAR (doutrina de MFA): quem tem fator verificado só recebe o token com a
  // sessão `aal2`. O fator vem do `user` do getUser (resposta do GoTrue), e o
  // nível do claim `aal` do mesmo JWT — sem outra ida à rede.
  const { data: aal, error: aalErr } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (sessaoDeveProvarSegundoFator(user, aalErr ? null : aal?.currentLevel)) {
    return fail("mfa_required", MENSAGEM_MFA_REQUIRED, 403, { requestId, headers: NO_STORE });
  }

  const teto = await checkRateLimit(
    `auth:realtime_token:user:${user.id}`,
    TETO_POR_USUARIO,
    JANELA_SEGUNDOS,
  );
  if (!teto.allowed) {
    return fail("rate_limited", "Muitos pedidos de token. Tente em um minuto.", 429, {
      requestId,
      headers: {
        ...NO_STORE,
        "Retry-After": String(JANELA_SEGUNDOS),
        "X-RateLimit-Limit": String(teto.limit),
        "X-RateLimit-Remaining": "0",
      },
    });
  }

  // getSession() aqui NÃO autentica (o getUser acima já autenticou): serve só
  // para extrair o token que o cookie httpOnly guarda.
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    return fail("unauthenticated", "Sessão sem token.", 401, { requestId, headers: NO_STORE });
  }

  return ok(
    { access_token: session.access_token, expires_at: session.expires_at ?? null },
    { requestId, headers: NO_STORE },
  );
}
