/**
 * R6 — as listagens que o turno do agente usa filtram pelo contato NO SERVIDOR.
 *
 * O escopo do contato (`lib/mcp/escopo-do-contato.ts`) injeta `contact_id` em
 * `crm_list_leads`, `crm_search_contacts` e `crm_list_human_cases`. Aqui se
 * prova a outra metade: o filtro chega à consulta. Antes, só a RESPOSTA de uma
 * página da base inteira era recortada — o contato do turno podia estar na
 * página seguinte, e o cursor apontava para o resto da base.
 */
import { describe, expect, it } from "vitest";

import { listContactsHandler } from "@/app/api/v1/contacts/_handler";
import { listLeadsHandler } from "@/app/api/v1/leads/_handler";
import { crmListHumanCases } from "@/lib/mcp/tools/escalacao";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const CONTATO = "aaaaaaaa-0000-4000-8000-0000000000c1";

type Chamada = [string, string, ...unknown[]];

/** Banco que registra cada método por tabela e devolve `linhas` no fim. */
function banco(linhas: (tabela: string) => unknown[] = () => []) {
  const chamadas: Chamada[] = [];
  const from = (tabela: string) => {
    const b: Record<string, unknown> = new Proxy(
      {},
      {
        get(_a, prop: string) {
          if (prop === "then") {
            return (r: (v: unknown) => unknown) => r({ data: linhas(tabela), error: null, count: 0 });
          }
          return (...args: unknown[]) => {
            chamadas.push([tabela, prop, ...args]);
            return b;
          };
        },
      },
    );
    return b;
  };
  return { supabase: { from } as never, chamadas };
}

const ctx = { organization_id: ORG, actor: { type: "ai_agent", id: "run" }, requestId: "req" } as never;

describe("filtro de contato no servidor", () => {
  it("listLeadsHandler aplica contact_id na consulta", async () => {
    const db = banco();
    await listLeadsHandler(db.supabase, ctx, { contact_id: CONTATO, limit: 20 });
    expect(db.chamadas).toContainEqual(["crm_leads", "eq", "contact_id", CONTATO]);
  });

  it("listContactsHandler aplica o contato pedido como filtro de id", async () => {
    const db = banco();
    await listContactsHandler(db.supabase, ctx, { search: "Ana", limit: 10 }, { contactId: CONTATO });
    expect(db.chamadas).toContainEqual(["contacts", "eq", "id", CONTATO]);
  });

  it("listContactsHandler sem a opção não filtra por id (a tela e a API seguem iguais)", async () => {
    const db = banco();
    await listContactsHandler(db.supabase, ctx, { search: "Ana", limit: 10 });
    expect(db.chamadas.some(([, m, col]) => m === "eq" && col === "id")).toBe(false);
  });

  it("crm_list_human_cases com contact_id recorta pelas conversas desse contato", async () => {
    const db = banco((t) => (t === "conversations" ? [{ id: "conv-1" }] : []));
    await crmListHumanCases.handler({ state: "abertos", limit: 20, contact_id: CONTATO }, {
      organizationId: ORG,
      supabase: db.supabase,
    } as never);
    expect(db.chamadas).toContainEqual(["conversations", "eq", "contact_id", CONTATO]);
    expect(db.chamadas).toContainEqual(["conversations", "eq", "organization_id", ORG]);
    expect(db.chamadas).toContainEqual(["agent_cases", "in", "conversation_id", ["conv-1"]]);
  });
});
