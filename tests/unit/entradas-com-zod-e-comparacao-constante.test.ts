import { readFileSync } from "node:fs";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Auditoria P10 (`docs/imobiliario/04-auditoria-seguranca-e-qualidade.md`):
 *  - `/api/internal/agents/run` comparava o segredo à mão, com saída cedo por
 *    tamanho — agora usa `timingSafeStringEqual` (hash de tamanho fixo);
 *  - o PATCH de `/api/v1/channels/templates` e o `/api/v1/leads/{id}/win`
 *    liam o corpo sem Zod e sem teto.
 */

const { encerraDemanda, adminAlcancado } = vi.hoisted(() => ({
  encerraDemanda: vi.fn(async (..._a: unknown[]) => ({ lead: { id: "lead-1" } })),
  adminAlcancado: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_SECRET: "segredo-interno-de-32-caracteres!", INTERNAL_CRON_SECRET: "" },
}));
vi.mock("@/lib/ai/runtime/agent", () => ({ runAgent: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "u1", idioma: "pt-BR" },
    org: { orgId: "org-1", role: "admin" },
  })),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    adminAlcancado();
    throw new Error("admin-alcancado");
  },
}));
vi.mock("@/lib/leads/encerramento", () => ({ encerraDemanda }));

import { POST as runPost } from "@/app/api/internal/agents/run/route";
import { PATCH as templatesPatch } from "@/app/api/v1/channels/templates/route";
import { POST as winPost } from "@/app/api/v1/leads/[id]/win/route";

beforeEach(() => {
  encerraDemanda.mockClear();
  adminAlcancado.mockClear();
});

describe("/api/internal/agents/run — comparação do segredo", () => {
  it("usa timingSafeStringEqual, não uma comparação à mão", () => {
    const fonte = readFileSync("app/api/internal/agents/run/route.ts", "utf8");
    expect(fonte).toMatch(/import \{ timingSafeStringEqual \} from "@\/lib\/auth\/cron-auth"/);
    expect(fonte).not.toMatch(/charCodeAt/);
  });

  it("segredo errado (inclusive de outro tamanho) → 401", async () => {
    for (const s of ["x", "segredo-interno-de-32-caracteres?"]) {
      const res = await runPost(
        new NextRequest("http://localhost/api/internal/agents/run", {
          method: "POST",
          headers: { "x-internal-secret": s },
          body: "{}",
        }),
      );
      expect(res.status).toBe(401);
    }
  });

  it("segredo certo passa da autenticação (vacuidade)", async () => {
    const res = await runPost(
      new NextRequest("http://localhost/api/internal/agents/run", {
        method: "POST",
        headers: { authorization: "Bearer segredo-interno-de-32-caracteres!" },
        body: "{}",
      }),
    );
    expect(res.status).not.toBe(401);
  });
});

describe("PATCH /api/v1/channels/templates — Zod com teto", () => {
  function patch(corpo: unknown) {
    return templatesPatch(
      new NextRequest("http://localhost/api/v1/channels/templates", {
        method: "PATCH",
        body: JSON.stringify(corpo),
      }),
    );
  }

  const RUINS: Array<[string, unknown]> = [
    ["valores demais", { name: "m", language: "pt_BR", values: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, "https://a.b/c"])) }],
    ["link gigante", { name: "m", language: "pt_BR", values: { "header:1": `https://a.b/${"x".repeat(3000)}` } }],
    ["nome gigante", { name: "n".repeat(600), language: "pt_BR", values: {} }],
    ["idioma gigante", { name: "m", language: "p".repeat(40), values: {} }],
    ["valor que não é texto", { name: "m", language: "pt_BR", values: { "header:1": 1 } }],
  ];
  for (const [rotulo, corpo] of RUINS) {
    it(`recusa ${rotulo} com 422, sem tocar o banco`, async () => {
      const res = await patch(corpo);
      expect(res.status).toBe(422);
      expect(adminAlcancado).not.toHaveBeenCalled();
    });
  }

  it("corpo válido segue para o banco (vacuidade)", async () => {
    await expect(
      patch({ name: "m", language: "pt_BR", values: { "header:1": "https://a.b/c.jpg" } }),
    ).rejects.toThrow("admin-alcancado");
  });
});

describe("POST /api/v1/leads/{id}/win — Zod com teto", () => {
  function win(corpo: string | undefined) {
    return winPost(
      new NextRequest("http://localhost/api/v1/leads/lead-1/win", {
        method: "POST",
        ...(corpo !== undefined ? { body: corpo } : {}),
      }),
      { params: Promise.resolve({ id: "lead-1" }) },
    );
  }

  it("won_reason acima de 500 caracteres → 422, sem encerrar", async () => {
    const res = await win(JSON.stringify({ won_reason: "a".repeat(501) }));
    expect(res.status).toBe(422);
    expect(encerraDemanda).not.toHaveBeenCalled();
  });

  it("won_reason que não é texto → 422", async () => {
    const res = await win(JSON.stringify({ won_reason: { x: 1 } }));
    expect(res.status).toBe(422);
  });

  it("corpo ausente continua sendo ganhar sem motivo (contrato antigo)", async () => {
    const res = await win(undefined);
    expect(res.status).toBe(200);
    expect(encerraDemanda).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ desfecho: "won", motivo: null }),
    );
  });

  it("motivo válido chega ao encerramento", async () => {
    await win(JSON.stringify({ won_reason: "Fechou à vista" }));
    expect(encerraDemanda).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ motivo: "Fechou à vista" }),
    );
  });
});
