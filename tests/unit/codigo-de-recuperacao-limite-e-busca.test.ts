/**
 * P9 — código de recuperação: teto de tentativas por e-mail, e o usuário é
 * achado em qualquer página do diretório (não só nos 200 primeiros).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { usuarioPorEmail, POR_PAGINA } from "@/lib/auth/usuario-por-email";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${url};307;` });
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => true,
}));

type U = { id: string; email: string };
function diretorio(total: number): U[] {
  return Array.from({ length: total }, (_, i) => ({ id: `id-${i}`, email: `pessoa${i}@exemplo.test` }));
}

function adminFalso(usuarios: U[]) {
  const listUsers = vi.fn(async ({ page, perPage }: { page: number; perPage: number }) => ({
    data: { users: usuarios.slice((page - 1) * perPage, page * perPage) },
    error: null,
  }));
  return { auth: { admin: { listUsers } } };
}

describe("usuarioPorEmail", () => {
  it("acha quem está além da primeira página", async () => {
    const lista = diretorio(POR_PAGINA + 300);
    const admin = adminFalso(lista);
    const r = await usuarioPorEmail(admin as never, "  PESSOA1250@exemplo.test ");
    expect(r).toEqual({ ok: true, user: lista[1250] });
    expect(admin.auth.admin.listUsers).toHaveBeenCalledTimes(2);
  });

  it("para na última página quando não acha", async () => {
    const admin = adminFalso(diretorio(10));
    expect(await usuarioPorEmail(admin as never, "ninguem@exemplo.test")).toEqual({ ok: true, user: null });
    expect(admin.auth.admin.listUsers).toHaveBeenCalledTimes(1);
  });

  it("erro da API não vira 'não existe'", async () => {
    const admin = { auth: { admin: { listUsers: vi.fn(async () => ({ data: { users: [] }, error: new Error("x") })) } } };
    expect(await usuarioPorEmail(admin as never, "a@b.c")).toEqual({ ok: false });
  });
});

describe("useRecoveryCode", () => {
  let ip = 0;
  beforeEach(() => {
    vi.mocked(headers).mockImplementation(
      async () => ({ get: (k: string) => (k === "x-forwarded-for" ? `192.0.2.${(ip++ % 200) + 1}` : null) }) as never,
    );
  });

  it("acha e queima o código de quem está além dos 200 primeiros", async () => {
    const lista = diretorio(250);
    const listUsers = adminFalso(lista).auth.admin.listUsers;
    const update = vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) }));
    const q = {
      select: () => q,
      eq: () => q,
      is: () => q,
      limit: () => q,
      maybeSingle: async () => ({ data: { id: "rc1", used_at: null }, error: null }),
      update,
    };
    vi.mocked(createAdminClient).mockReturnValue({
      auth: {
        admin: {
          listUsers,
          mfa: { listFactors: async () => ({ data: { factors: [] } }), deleteFactor: vi.fn() },
        },
      },
      from: () => q,
    } as never);

    const { useRecoveryCode: usarCodigo } = await import("@/app/actions/auth/useRecoveryCode");
    const err = await usarCodigo({ email: "pessoa230@exemplo.test", code: "ABCD1234" }).catch((e) => e);
    expect(String((err as { digest?: string }).digest)).toContain("/login?recovery_used=1");
    expect(update).toHaveBeenCalled();
  });

  it("teto por e-mail: a 6ª tentativa na hora é recusada sem consultar nada", async () => {
    const listUsers = vi.fn(async () => ({ data: { users: [] }, error: null }));
    vi.mocked(createAdminClient).mockReturnValue({ auth: { admin: { listUsers } } } as never);
    const { useRecoveryCode: usarCodigo } = await import("@/app/actions/auth/useRecoveryCode");
    const email = `alvo-${Date.now()}@exemplo.test`;
    for (let i = 0; i < 5; i++) {
      expect(await usarCodigo({ email, code: "ZZZZ0000" })).toEqual({
        ok: false,
        error: "invalid_or_used",
      });
    }
    const chamadasAntes = listUsers.mock.calls.length;
    expect(await usarCodigo({ email, code: "ZZZZ0000" })).toEqual({ ok: false, error: "rate_limited" });
    expect(listUsers.mock.calls.length).toBe(chamadasAntes);
  }, 20_000);
});
