/**
 * A4/A5 — tokens de API: o que a tela lista, o que uma pessoa pode emitir, quem
 * assina o token efêmero do agente e o que a poda diária pode apagar.
 *
 *  1. `GET /api/v1/settings/api-tokens` não lista os efêmeros (`agent-run:*`,
 *     um por turno) e tem teto.
 *  2. `POST` recusa papel acima do de quem cria e escopo reservado do servidor.
 *  3. `resolveCreatedBy` só escolhe membro ATIVO e desempata pelo RANK do papel
 *     — `order("role", desc)` era ordem alfabética e escolhia `viewer`.
 *  4. A poda só apaga token efêmero vencido e NÃO citado pela auditoria: o FK
 *     `api_audit_log.actor_api_token_id` é `ON DELETE SET NULL`, e apagar um
 *     token citado reescreveria linhas da auditoria append-only.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { GET, LIMITE_DA_LISTAGEM, POST } from "@/app/api/v1/settings/api-tokens/route";
import { PREFIXO_DO_TOKEN_EFEMERO, resolveCreatedBy } from "@/lib/ai/runtime/mcp_token";
import {
  LOTE_DE_TOKENS,
  podaDeTokensSobre,
  podarTokensEfemeros,
} from "@/app/api/v1/cron/data-retention/route";

const ORG = "dddddddd-0000-4000-8000-000000000001";
const USUARIO = "dddddddd-0000-4000-8000-0000000000a1";

type Chamada = [string, ...unknown[]];

/** Builder que registra cada método chamado, e resolve no `resultado`. */
function builder(resultado: unknown, chamadas: Chamada[]) {
  const b: Record<string, unknown> = new Proxy(
    {},
    {
      get(_a, prop: string) {
        if (prop === "then") return (r: (v: unknown) => unknown) => r(resultado);
        return (...args: unknown[]) => {
          chamadas.push([prop, ...args]);
          return b;
        };
      },
    },
  );
  return b;
}

function autorizar(papel: string) {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USUARIO, idioma: "pt-BR" },
    org: { orgId: ORG, name: "Org", role: papel },
  } as never);
}

beforeEach(() => {
  vi.mocked(requireRole).mockReset();
  vi.mocked(createClient).mockReset();
  vi.mocked(createAdminClient).mockReset();
});

describe("GET /api/v1/settings/api-tokens — só chaves de gente", () => {
  it("exclui os efêmeros do agente pelo nome reservado e tem teto", async () => {
    autorizar("admin");
    const chamadas: Chamada[] = [];
    vi.mocked(createClient).mockResolvedValue({
      from: () => builder({ data: [], error: null }, chamadas),
    } as never);

    const res = await GET(new NextRequest("http://localhost/api/v1/settings/api-tokens"));
    expect(res.status).toBe(200);
    expect(chamadas).toContainEqual(["not", "name", "like", `${PREFIXO_DO_TOKEN_EFEMERO}%`]);
    expect(chamadas).toContainEqual(["limit", LIMITE_DA_LISTAGEM]);
    expect(chamadas).toContainEqual(["eq", "organization_id", ORG]);
  });
});

describe("POST /api/v1/settings/api-tokens — o que uma pessoa pode emitir", () => {
  async function criar(papel: string, corpo: Record<string, unknown>) {
    autorizar(papel);
    const inserts: unknown[] = [];
    vi.mocked(createClient).mockResolvedValue({
      from: () => {
        const chamadas: Chamada[] = [];
        const b = builder({ data: { id: "tok-1" }, error: null }, chamadas);
        return new Proxy(b, {
          get(alvo, prop: string) {
            if (prop === "insert") {
              return (linha: unknown) => {
                inserts.push(linha);
                return alvo;
              };
            }
            return Reflect.get(alvo, prop);
          },
        });
      },
    } as never);
    const res = await POST(
      new NextRequest("http://localhost/api/v1/settings/api-tokens", {
        method: "POST",
        body: JSON.stringify(corpo),
      }),
    );
    return { status: res.status, inserts };
  }

  it("admin emite token de gerente", async () => {
    const r = await criar("admin", { name: "n8n", scopes: ["mcp:read", "role:manager"] });
    expect(r.status).toBe(201);
    expect(r.inserts).toHaveLength(1);
  });

  it("papel acima do de quem cria é recusado antes do insert", async () => {
    // `requireRole("admin")` barra quem não é admin; o caso cobre o papel
    // EFETIVO devolvido por ele (suporte em modo leitura resolve `viewer`).
    const r = await criar("viewer", { name: "n8n", scopes: ["mcp:read", "role:admin"] });
    expect(r.status).toBe(422);
    expect(r.inserts).toHaveLength(0);
  });

  it("escopo reservado do servidor é recusado antes do insert", async () => {
    const r = await criar("admin", {
      name: "falso agente",
      scopes: ["mcp:read", "mcp:write", "actor:ai_agent", "agent_run:x"],
    });
    expect(r.status).toBe(422);
    expect(r.inserts).toHaveLength(0);
  });
});

describe("resolveCreatedBy — membro ativo, desempate pelo rank", () => {
  function membros(linhas: Array<{ user_id: string; role: string }>) {
    const chamadas: Chamada[] = [];
    vi.mocked(createAdminClient).mockReturnValue({
      from: () => builder({ data: linhas, error: null }, chamadas),
    } as never);
    return chamadas;
  }

  it("sem candidato, escolhe o papel MAIS ALTO (não o último em ordem alfabética)", async () => {
    membros([
      { user_id: "u-viewer", role: "viewer" },
      { user_id: "u-admin", role: "admin" },
      { user_id: "u-agent", role: "agent" },
      { user_id: "u-manager", role: "manager" },
    ]);
    expect(await resolveCreatedBy(ORG)).toBe("u-admin");
  });

  it("candidato que ainda é membro ativo vence; o que saiu é pulado", async () => {
    const chamadas = membros([
      { user_id: "u-agent", role: "agent" },
      { user_id: "u-admin", role: "admin" },
    ]);
    expect(await resolveCreatedBy(ORG, "u-saiu", "u-agent")).toBe("u-agent");
    expect(chamadas).toContainEqual(["is", "revoked_at", null]);
  });

  it("organização sem membro ativo: nulo (o mint recusa)", async () => {
    membros([]);
    expect(await resolveCreatedBy(ORG, "u-saiu")).toBeNull();
  });
});

describe("poda dos efêmeros — nunca reescreve auditoria", () => {
  it("só seleciona efêmero vencido e SEM linha de auditoria nem rascunho que o cite", async () => {
    const chamadas: Chamada[] = [];
    const apagou: Chamada[] = [];
    let n = 0;
    const admin = {
      from: () => {
        n += 1;
        return n === 1
          ? builder({ data: [{ id: "t1" }, { id: "t2" }], error: null }, chamadas)
          : builder({ data: [{ id: "t1" }, { id: "t2" }], error: null }, apagou);
      },
    };
    const r = await podaDeTokensSobre(admin).apagarTokensEfemeros("2026-09-26T00:00:00.000Z", 50);

    expect(r).toEqual({ data: 2, error: null });
    expect(chamadas).toContainEqual(["like", "name", `${PREFIXO_DO_TOKEN_EFEMERO}%`]);
    expect(chamadas).toContainEqual(["contains", "scopes", JSON.stringify(["actor:ai_agent"])]);
    expect(chamadas).toContainEqual(["lt", "expires_at", "2026-09-26T00:00:00.000Z"]);
    // O anti-join: token citado pela auditoria (FK ON DELETE SET NULL) fica.
    expect(chamadas).toContainEqual(["is", "api_audit_log", null]);
    expect(chamadas).toContainEqual(["is", "conversation_drafts", null]);
    // E o DELETE repete as guardas, não confia só na lista de ids.
    expect(apagou).toContainEqual(["in", "id", ["t1", "t2"]]);
    expect(apagou).toContainEqual(["like", "name", `${PREFIXO_DO_TOKEN_EFEMERO}%`]);
  });

  it("lote incompleto encerra; lote cheio continua até o teto", async () => {
    const lotes = [LOTE_DE_TOKENS, 3];
    const r = await podarTokensEfemeros(
      { apagarTokensEfemeros: async () => ({ data: lotes.shift() ?? 0, error: null }) },
      new Date("2026-09-27T12:00:00Z"),
    );
    expect(r).toEqual({ apagados: LOTE_DE_TOKENS + 3, lotes: 2, temResto: false });
  });

  it("o corte fica um dia depois do vencimento", async () => {
    const cortes: string[] = [];
    await podarTokensEfemeros(
      {
        apagarTokensEfemeros: async (corte) => {
          cortes.push(corte);
          return { data: 0, error: null };
        },
      },
      new Date("2026-09-27T12:00:00Z"),
    );
    expect(cortes).toEqual(["2026-09-26T12:00:00.000Z"]);
  });

  it("erro do banco sobe (não vira 'nada a podar')", async () => {
    await expect(
      podarTokensEfemeros({
        apagarTokensEfemeros: async () => ({ data: null, error: { message: "boom" } }),
      }),
    ).rejects.toThrow(/boom/);
  });
});
