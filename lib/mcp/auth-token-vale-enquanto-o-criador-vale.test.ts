/**
 * A4 — o token vale enquanto quem o criou vale.
 *
 * Antes: `resolveApiToken` conferia só `revoked_at`/`expires_at` do TOKEN. Um
 * admin removido da organização (ou rebaixado) seguia operando o CRM pelo
 * token `role:manager` que emitiu antes de sair.
 *
 * Agora, a cada uso: `created_by` tem de ser membro ATIVO da organização do
 * token (`user_organizations.revoked_at is null`) com papel que alcance o
 * `role:` do token. O token efêmero do agente (`actor:ai_agent`, papel de
 * máquina `ai_operator`) confere só a filiação.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/rate-limit", () => ({
  registrarFalhaDeToken: vi.fn(async () => undefined),
  tokenFailureLimited: vi.fn(async () => false),
}));

import { createAdminClient } from "@/lib/supabase/admin";

import { ApiTokenError, McpAuthError, resolveApiToken, validateBearerToken } from "./auth";

const TOKEN_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const ORG_ID = "bbbbbbbb-2222-4222-8222-222222222222";
const CRIADOR = "cccccccc-3333-4333-8333-333333333333";
const PLAINTEXT = "dsk_abcd_segredo";

interface Cenario {
  scopes: string[];
  /** O que `user_organizations` devolve para (criador, org, revoked_at is null). */
  membro: { role: string } | null;
  erroDaFiliacao?: { message: string } | null;
}

const filtrosDaFiliacao: Array<[string, string, unknown]> = [];

function armar(c: Cenario) {
  filtrosDaFiliacao.length = 0;
  vi.mocked(createAdminClient).mockReturnValue({
    from: (tabela: string) => {
      const cadeia: Record<string, unknown> = {};
      cadeia.select = () => cadeia;
      cadeia.eq = (col: string, v: unknown) => {
        if (tabela === "user_organizations") filtrosDaFiliacao.push(["eq", col, v]);
        return cadeia;
      };
      cadeia.is = (col: string, v: unknown) => {
        if (tabela === "user_organizations") filtrosDaFiliacao.push(["is", col, v]);
        return cadeia;
      };
      cadeia.update = () => cadeia;
      cadeia.then = (r: (v: unknown) => unknown) => r({ error: null });
      cadeia.maybeSingle = async () =>
        tabela === "user_organizations"
          ? { data: c.membro, error: c.erroDaFiliacao ?? null }
          : {
              data: {
                id: TOKEN_ID,
                organization_id: ORG_ID,
                scopes: c.scopes,
                revoked_at: null,
                expires_at: null,
                created_by: CRIADOR,
              },
              error: null,
            };
      return cadeia;
    },
  } as never);
}

async function motivo(c: Cenario): Promise<string> {
  armar(c);
  try {
    await resolveApiToken(PLAINTEXT);
    return "ok";
  } catch (e) {
    if (e instanceof ApiTokenError) return e.reason;
    throw e;
  }
}

beforeEach(() => {
  vi.mocked(createAdminClient).mockReset();
});

describe("resolveApiToken — a filiação de quem criou", () => {
  it("criador ativo com papel suficiente: o token vale", async () => {
    expect(await motivo({ scopes: ["mcp:read", "role:manager"], membro: { role: "admin" } })).toBe("ok");
    expect(await motivo({ scopes: ["mcp:read", "role:manager"], membro: { role: "manager" } })).toBe("ok");
    // sem `role:` o token é `agent`
    expect(await motivo({ scopes: ["mcp:read"], membro: { role: "agent" } })).toBe("ok");
  });

  it("consulta a filiação ATIVA, do criador, na organização DO TOKEN", async () => {
    await motivo({ scopes: ["mcp:read"], membro: { role: "admin" } });
    expect(filtrosDaFiliacao).toEqual(
      expect.arrayContaining([
        ["eq", "user_id", CRIADOR],
        ["eq", "organization_id", ORG_ID],
        ["is", "revoked_at", null],
      ]),
    );
  });

  it("criador que saiu da organização: recusado", async () => {
    expect(await motivo({ scopes: ["mcp:read", "role:manager"], membro: null })).toBe("creator_inactive");
  });

  it("criador rebaixado abaixo do papel do token: recusado", async () => {
    expect(await motivo({ scopes: ["mcp:read", "role:manager"], membro: { role: "agent" } })).toBe(
      "creator_inactive",
    );
    expect(await motivo({ scopes: ["mcp:read", "role:admin"], membro: { role: "manager" } })).toBe(
      "creator_inactive",
    );
  });

  it("token efêmero do agente: basta o criador ser membro ativo (ai_operator é papel de máquina)", async () => {
    const efemero = ["mcp:read", "mcp:write", "actor:ai_agent", "agent_run:r1", "role:ai_operator"];
    expect(await motivo({ scopes: efemero, membro: { role: "agent" } })).toBe("ok");
    expect(await motivo({ scopes: efemero, membro: null })).toBe("creator_inactive");
  });

  it("`actor:ai_agent` forjado com `role:admin` não escapa da comparação", async () => {
    expect(
      await motivo({ scopes: ["mcp:read", "actor:ai_agent", "role:admin"], membro: { role: "agent" } }),
    ).toBe("creator_inactive");
  });

  it("falha ao ler a filiação é falha NOSSA (lookup_failed), não token inválido", async () => {
    expect(
      await motivo({ scopes: ["mcp:read"], membro: null, erroDaFiliacao: { message: "reset" } }),
    ).toBe("lookup_failed");
  });

  it("no MCP, criador inativo vira 401 com mensagem para quem chama", async () => {
    armar({ scopes: ["mcp:read", "role:manager"], membro: null });
    const erro = await validateBearerToken(`Bearer ${PLAINTEXT}`).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(McpAuthError);
    expect((erro as McpAuthError).httpStatus).toBe(401);
    expect((erro as McpAuthError).message).toMatch(/left the organization/);
  });
});
