/**
 * O `proxy.ts` como porta: MFA na borda (W1), X-Request-Id que chega ao
 * handler (W6) e HSTS por instalação (W4).
 *
 * O proxy é exercitado de verdade — `NextRequest` real, `NextResponse.next`
 * real. Só o cliente do Supabase é falso, porque o que se mede aqui é a
 * decisão do proxy dado o que o GoTrue respondeu.
 *
 * ── Como se lê "o handler viu o cabeçalho" ──────────────────────────────────
 * `NextResponse.next({ request: { headers } })` serializa os cabeçalhos da
 * requisição na resposta como `x-middleware-request-<nome>` e lista os nomes
 * em `x-middleware-override-headers`; é isso que o servidor do Next aplica à
 * requisição antes de chamar o handler. Ler esses dois é ler o que o handler
 * recebe — e é exatamente o que a versão anterior não produzia para o id.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({
  user: null as null | { id: string; factors?: { status: string }[] },
  aal: { currentLevel: "aal1" as string | null, nextLevel: "aal1" as string | null },
  aalErro: null as null | Error,
  appUrl: "https://crm.exemplo.com.br",
  chamadasAal: 0,
}));

vi.mock("@/lib/env", () => ({
  env: new Proxy(
    {},
    {
      get: (_t, chave) => {
        if (chave === "NEXT_PUBLIC_APP_URL") return estado.appUrl;
        if (chave === "NEXT_PUBLIC_SUPABASE_URL") return "https://sb.exemplo.com";
        if (chave === "NEXT_PUBLIC_SUPABASE_ANON_KEY") return "anon";
        return undefined;
      },
    },
  ),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: estado.user }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => {
          estado.chamadasAal += 1;
          return estado.aalErro
            ? { data: null, error: estado.aalErro }
            : { data: { ...estado.aal, currentAuthenticationMethods: [] }, error: null };
        },
      },
    },
    rpc: async () => ({ data: true, error: null }),
  }),
}));

import { proxy } from "@/proxy";

const COM_FATOR = { id: "u1", factors: [{ status: "verified" }] };
const SEM_FATOR = { id: "u2", factors: [] as { status: string }[] };

function req(caminho: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new URL(caminho, "https://crm.exemplo.com.br"), { headers });
}

function vistoPeloHandler(res: Response, nome: string): string | null {
  const lista = (res.headers.get("x-middleware-override-headers") ?? "").split(",");
  if (!lista.includes(nome)) return null;
  return res.headers.get(`x-middleware-request-${nome}`);
}

beforeEach(() => {
  estado.user = null;
  estado.aal = { currentLevel: "aal1", nextLevel: "aal1" };
  estado.aalErro = null;
  estado.appUrl = "https://crm.exemplo.com.br";
  estado.chamadasAal = 0;
});

describe("W1 — sessão aal1 de quem TEM fator não passa da borda", () => {
  it("tela: redireciona para /login/mfa com o destino preservado", async () => {
    estado.user = COM_FATOR;
    const res = await proxy(req("/app/inbox?aba=minhas"));
    expect(res.status).toBe(307);
    const destino = new URL(res.headers.get("location")!);
    expect(destino.pathname).toBe("/login/mfa");
    expect(destino.searchParams.get("next")).toBe("/app/inbox?aba=minhas");
  });

  it("API: 403 com o envelope de erro e código mfa_required", async () => {
    estado.user = COM_FATOR;
    const res = await proxy(req("/api/v1/auth/realtime-token"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "mfa_required", message: expect.any(String) },
    });
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("falha fechada: leitura do nível com erro conta como não provado", async () => {
    estado.user = COM_FATOR;
    estado.aal = { currentLevel: "aal2", nextLevel: "aal2" };
    estado.aalErro = new Error("jwt ilegível");
    const res = await proxy(req("/api/v1/leads"));
    expect(res.status).toBe(403);
  });

  it("não confia no nextLevel (vem da cópia do usuário no COOKIE)", async () => {
    // Quem tem só a senha edita o cookie e apaga os fatores da cópia: o
    // nextLevel cai para aal1. O proxy decide pelo user do getUser().
    estado.user = COM_FATOR;
    estado.aal = { currentLevel: "aal1", nextLevel: "aal1" };
    const res = await proxy(req("/app"));
    expect(res.status).toBe(307);
  });

  it("sessão aal2 segue normalmente", async () => {
    estado.user = COM_FATOR;
    estado.aal = { currentLevel: "aal2", nextLevel: "aal2" };
    const res = await proxy(req("/app/inbox"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("location")).toBeNull();
  });

  it("quem NÃO tem fator não é tocado — e nem paga a leitura do nível", async () => {
    // O cadastro (política) é do MfaEnrollGate; a borda só cobra a PROVA.
    estado.user = SEM_FATOR;
    const res = await proxy(req("/app"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(estado.chamadasAal).toBe(0);
  });

  it("fator que a tela de MFA não desafia (não-TOTP) não vira laço de redirect", async () => {
    // `/login/mfa` só desafia TOTP e devolve para /app quem não tem; contar
    // outro tipo aqui mandaria a pessoa de volta para lá, sem fim.
    estado.user = { id: "u3", factors: [{ status: "verified", factor_type: "phone" } as never] };
    const res = await proxy(req("/app"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("as telas do próprio fluxo de MFA seguem alcançáveis", async () => {
    estado.user = COM_FATOR;
    for (const caminho of ["/login/mfa", "/login/recovery", "/acesso-revogado"]) {
      const res = await proxy(req(caminho));
      expect(res.headers.get("x-middleware-next"), caminho).toBe("1");
    }
  });

  it("sem sessão continua 401 na API", async () => {
    const res = await proxy(req("/api/v1/leads"));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthenticated");
  });
});

describe("W6 — X-Request-Id chega ao handler e sai em toda resposta", () => {
  it("id válido do cliente é propagado ao handler e à resposta", async () => {
    estado.user = SEM_FATOR;
    const res = await proxy(req("/app", { "x-request-id": "abc-123_XYZ" }));
    expect(vistoPeloHandler(res, "x-request-id")).toBe("abc-123_XYZ");
    expect(res.headers.get("x-request-id")).toBe("abc-123_XYZ");
    expect(vistoPeloHandler(res, "x-pathname")).toBe("/app");
  });

  it("id sem a forma de identificador é trocado por um UUID", async () => {
    estado.user = SEM_FATOR;
    const res = await proxy(req("/app", { "x-request-id": "a b<script>" }));
    const id = vistoPeloHandler(res, "x-request-id");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get("x-request-id")).toBe(id);
  });

  it("id longo demais é trocado", async () => {
    estado.user = SEM_FATOR;
    const res = await proxy(req("/app", { "x-request-id": "a".repeat(65) }));
    expect(vistoPeloHandler(res, "x-request-id")).not.toBe("a".repeat(65));
  });

  it("caminho público também repassa o id ao handler", async () => {
    const res = await proxy(req("/api/v1/health", { "x-request-id": "saude-1" }));
    expect(vistoPeloHandler(res, "x-request-id")).toBe("saude-1");
  });

  it("redirects e 403 levam o id", async () => {
    const semSessao = await proxy(req("/app", { "x-request-id": "r-1" }));
    expect(semSessao.status).toBe(307);
    expect(semSessao.headers.get("x-request-id")).toBe("r-1");

    estado.user = COM_FATOR;
    const mfa = await proxy(req("/api/v1/leads", { "x-request-id": "r-2" }));
    expect(mfa.status).toBe(403);
    expect(mfa.headers.get("x-request-id")).toBe("r-2");
  });
});

describe("W4 — HSTS só quando a instalação declara https", () => {
  it("https: manda Strict-Transport-Security", async () => {
    const res = await proxy(req("/api/v1/health"));
    expect(res.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });

  it("http (instalação por IP): não manda", async () => {
    estado.appUrl = "http://203.0.113.5:3000";
    const res = await proxy(req("/api/v1/health"));
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });
});
