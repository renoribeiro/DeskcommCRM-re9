import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/v1/webhooks/in/{token} — auditoria P8
 * (`docs/imobiliario/04-auditoria-seguranca-e-qualidade.md`).
 *
 * A fonte TEM segredo configurado, mas ele não decifra (chave da GUC ausente
 * ou trocada). Antes: o evento era ACEITO sem conferir a assinatura — a fonte
 * cujo dono pediu assinatura aceitava qualquer um. Agora: 503, nada gravado
 * como recebido, nenhum lead criado, e a captação registra o porquê.
 */

const { estado, inserts, registrarCaptacao, createLeadHandler } = vi.hoisted(() => ({
  estado: { segredo: null as string | null },
  inserts: [] as Array<{ tabela: string; linha: unknown }>,
  registrarCaptacao: vi.fn(async (..._args: unknown[]) => undefined),
  createLeadHandler: vi.fn(),
}));

vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: vi.fn(async () => estado.segredo),
}));
vi.mock("@/lib/webhooks/captacao", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/webhooks/captacao")>();
  return { ...real, registrarCaptacao };
});
vi.mock("@/app/api/v1/leads/_handler", () => ({ createLeadHandler }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = () => c;
      c.maybeSingle = async () =>
        tabela === "webhook_sources"
          ? {
              data: {
                id: "src-1",
                name: "Formulário do site",
                organization_id: "org-1",
                secret_encrypted: "\\x00cifrado",
                default_pipeline_id: null,
                default_stage_id: null,
                field_map: {},
                redirect_to: null,
                is_active: true,
              },
              error: null,
            }
          : { data: null, error: null };
      c.insert = (linha: unknown) => {
        inserts.push({ tabela, linha });
        return { select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) };
      };
      return c;
    },
  }),
}));

import { POST } from "@/app/api/v1/webhooks/in/[token]/route";

function chamar() {
  return POST(
    new NextRequest("http://localhost/api/v1/webhooks/in/token-da-fonte", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nome: "Fulano", telefone: "11999998888" }),
    }),
    { params: Promise.resolve({ token: "token-da-fonte" }) },
  );
}

beforeEach(() => {
  inserts.length = 0;
  registrarCaptacao.mockClear();
  createLeadHandler.mockClear();
});

describe("segredo configurado que não decifra", () => {
  it("responde 503 com Retry-After e não aceita o evento", async () => {
    estado.segredo = null;
    const res = await chamar();
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(inserts.filter((i) => i.tabela === "webhook_events_log")).toHaveLength(0);
    expect(createLeadHandler).not.toHaveBeenCalled();
  });

  it("registra a captação como recusada, com o motivo", async () => {
    estado.segredo = null;
    await chamar();
    expect(registrarCaptacao).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "recusado", rejectReason: "segredo_indisponivel" }),
    );
  });

  it("com o segredo decifrado e sem assinatura, segue recusando com 401 (vacuidade)", async () => {
    estado.segredo = "segredo-da-fonte";
    const res = await chamar();
    expect(res.status).toBe(401);
  });
});
