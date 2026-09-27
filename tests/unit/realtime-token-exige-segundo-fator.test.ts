/**
 * W5 — `GET /api/v1/auth/realtime-token` entrega um JWT de sessão. Ele só sai
 * para sessão que provou o segundo fator, quando há fator; tem teto por
 * usuário; e nunca é cacheável.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({
  user: null as null | { id: string; factors?: { status: string }[] },
  aal: "aal1" as string | null,
  permitido: true,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: estado.user }, error: null }),
      getSession: async () => ({
        data: { session: { access_token: "jwt-da-sessao", expires_at: 123 } },
      }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: estado.aal, nextLevel: estado.aal },
          error: null,
        }),
      },
    },
  }),
}));

vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(async (_b: string, limit: number, window_sec: number) => ({
    allowed: estado.permitido,
    count: estado.permitido ? 1 : limit + 1,
    limit,
    window_sec,
  })),
}));

import { GET } from "@/app/api/v1/auth/realtime-token/route";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";

const req = () => new NextRequest("https://crm.exemplo.com.br/api/v1/auth/realtime-token");

beforeEach(() => {
  estado.user = null;
  estado.aal = "aal1";
  estado.permitido = true;
  vi.mocked(checkRateLimit).mockClear();
});

describe("realtime-token", () => {
  it("quem tem fator e está em aal1 NÃO recebe o token (403 mfa_required)", async () => {
    estado.user = { id: "u1", factors: [{ status: "verified" }] };
    const res = await GET(req());
    expect(res.status).toBe(403);
    const corpo = await res.json();
    expect(corpo.error.code).toBe("mfa_required");
    expect(JSON.stringify(corpo)).not.toContain("jwt-da-sessao");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("quem tem fator e provou (aal2) recebe", async () => {
    estado.user = { id: "u1", factors: [{ status: "verified" }] };
    estado.aal = "aal2";
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).data.access_token).toBe("jwt-da-sessao");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("quem não tem fator recebe em aal1 (o cadastro é da política, não daqui)", async () => {
    estado.user = { id: "u2", factors: [] };
    const res = await GET(req());
    expect(res.status).toBe(200);
  });

  it("teto por usuário: 429 com Retry-After, sem token", async () => {
    estado.user = { id: "u2", factors: [] };
    estado.permitido = false;
    const res = await GET(req());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(JSON.stringify(await res.json())).not.toContain("jwt-da-sessao");
    expect(vi.mocked(checkRateLimit).mock.calls[0]![0]).toContain("u2");
  });
});
