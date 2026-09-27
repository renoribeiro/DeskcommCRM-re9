import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PUT /api/v1/ai/providers — auditoria P4
 * (`docs/imobiliario/04-auditoria-seguranca-e-qualidade.md`).
 *
 * O `base_url` gravado aqui vira o destino da chave da organização em toda
 * chamada do ponto. Endereço interno é recusado na ESCRITA (422), antes de
 * tocar o banco; o motor ainda julga a cada chamada, mas a tela precisa dizer
 * na hora que o endereço não serve.
 */

vi.mock("node:dns/promises", () => {
  const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
  return { lookup, default: { lookup } };
});
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", idioma: "pt-BR" },
    org: { orgId: "22222222-2222-4222-8222-222222222222", role: "admin" },
  })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
const createClient = vi.fn(async () => {
  throw new Error("banco-alcancado");
});
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createClient() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { PUT } from "@/app/api/v1/ai/providers/route";

function put(base_url: string) {
  return PUT(
    new NextRequest("http://localhost/api/v1/ai/providers", {
      method: "PUT",
      body: JSON.stringify({
        purpose: "agent_turn",
        provider: "openrouter",
        model_id: "x/y",
        base_url,
      }),
    }),
  );
}

beforeEach(() => {
  createClient.mockClear();
});

describe("PUT /api/v1/ai/providers — base_url passa pela régua de destino", () => {
  const INTERNOS = [
    ["rede privada", "http://10.0.0.5/v1"],
    ["metadado de nuvem", "http://169.254.169.254/latest"],
    ["loopback", "http://127.0.0.1:3000/v1"],
    ["serviço do compose por nome", "http://localhost:8000/v1"],
  ] as const;

  for (const [rotulo, url] of INTERNOS) {
    it(`recusa ${rotulo} com 422, sem tocar o banco`, async () => {
      const res = await put(url);
      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error.code).toBe("base_url_recusada");
      expect(createClient).not.toHaveBeenCalled();
    });
  }

  it("endereço público passa da régua e segue para o banco (vacuidade)", async () => {
    await expect(put("https://gateway.exemplo.com/v1")).rejects.toThrow("banco-alcancado");
    expect(createClient).toHaveBeenCalledTimes(1);
  });
});
