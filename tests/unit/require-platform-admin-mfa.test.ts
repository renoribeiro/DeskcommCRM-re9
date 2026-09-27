/**
 * W2 — o gate da administração da plataforma cobra a PROVA do segundo fator de
 * quem TEM fator, e não só de quem a política obriga a cadastrar.
 *
 * `platform_admins.mfa_required` é política de CADASTRO. Antes, só ela abria a
 * checagem de `aal`: o admin que ativou o TOTP por vontade própria (ou cuja
 * plataforma desligou a exigência) operava as 19 rotas de `/api/v1/admin/*`
 * com a sessão `aal1` — só com a senha.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({
  user: null as null | { id: string; factors?: { status: string }[] },
  paRow: null as null | { user_id: string; scope: string; mfa_required: boolean },
  aal: "aal1" as string | null,
  aalErro: null as null | Error,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: estado.user }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () =>
          estado.aalErro
            ? { data: null, error: estado.aalErro }
            : { data: { currentLevel: estado.aal, nextLevel: estado.aal }, error: null },
      },
    },
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        is: () => q,
        maybeSingle: async () => ({ data: estado.paRow, error: null }),
      };
      return q;
    },
  }),
}));

import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { falhaDoGuardaDeAdmin } from "@/lib/auth/falha-do-guarda-de-admin";

const COM_FATOR = { id: "u1", factors: [{ status: "verified" }] };
const SEM_FATOR = { id: "u1", factors: [] as { status: string }[] };
const LINHA = (mfa_required: boolean) => ({ user_id: "u1", scope: "full", mfa_required });

async function destinoDaRecusa(): Promise<string | null> {
  try {
    await requirePlatformAdmin();
    return null;
  } catch (err) {
    const digest = (err as { digest?: string }).digest ?? "";
    return digest.split(";").slice(2, -2).join(";");
  }
}

beforeEach(() => {
  estado.user = null;
  estado.paRow = null;
  estado.aal = "aal1";
  estado.aalErro = null;
});

describe("requirePlatformAdmin — PROVAR segue quem tem fator", () => {
  it("admin com fator e sessão aal1 vai provar, mesmo com mfa_required=false", async () => {
    estado.user = COM_FATOR;
    estado.paRow = LINHA(false);
    expect(await destinoDaRecusa()).toBe("/login/mfa?next=/admin");
  });

  it("mfa_required=true continua cobrando (inclusive sem fator)", async () => {
    estado.user = SEM_FATOR;
    estado.paRow = LINHA(true);
    expect(await destinoDaRecusa()).toBe("/login/mfa?next=/admin");
  });

  it("sem fator e sem exigência, aal1 passa", async () => {
    estado.user = SEM_FATOR;
    estado.paRow = LINHA(false);
    expect(await destinoDaRecusa()).toBeNull();
  });

  it("com fator e sessão aal2, passa", async () => {
    estado.user = COM_FATOR;
    estado.paRow = LINHA(false);
    estado.aal = "aal2";
    expect(await destinoDaRecusa()).toBeNull();
  });

  it("falha fechada: leitura do nível com erro não prova nada", async () => {
    estado.user = COM_FATOR;
    estado.paRow = LINHA(false);
    estado.aal = "aal2";
    estado.aalErro = new Error("x");
    expect(await destinoDaRecusa()).toBe("/login/mfa?next=/admin");
  });

  it("quem não é admin da plataforma continua indo para /admin/forbidden", async () => {
    estado.user = COM_FATOR;
    expect(await destinoDaRecusa()).toBe("/admin/forbidden");
  });
});

describe("falhaDoGuardaDeAdmin — rota de API responde JSON, nunca redirect", () => {
  it("redirect para a prova de MFA vira 403 mfa_required", async () => {
    estado.user = COM_FATOR;
    estado.paRow = LINHA(false);
    const err = await requirePlatformAdmin().catch((e: unknown) => e);
    const res = falhaDoGuardaDeAdmin(err, "req-1");
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("mfa_required");
    expect(res.headers.get("location")).toBeNull();
  });

  it("outras recusas continuam 403 forbidden", async () => {
    estado.user = COM_FATOR;
    const naoAdmin = await requirePlatformAdmin().catch((e: unknown) => e);
    expect((await falhaDoGuardaDeAdmin(naoAdmin).json()).error.code).toBe("forbidden");
    expect((await falhaDoGuardaDeAdmin(new Error("boom")).json()).error.code).toBe("forbidden");
  });

  it("toda rota de API que chama o gate traduz a recusa por este helper", () => {
    const rotas = execFileSync("git", ["grep", "-l", "await requirePlatformAdmin()", "--", "app/api"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter((f) => f.endsWith("route.ts"));
    expect(rotas.length).toBeGreaterThan(15);
    const semHelper = rotas.filter((f) => {
      const fonte = readFileSync(f, "utf8");
      const chamadas = fonte.split("await requirePlatformAdmin()").length - 1;
      const traduzidas = fonte.split("falhaDoGuardaDeAdmin(err").length - 1;
      return traduzidas < chamadas;
    });
    expect(semHelper).toEqual([]);
  });
});
