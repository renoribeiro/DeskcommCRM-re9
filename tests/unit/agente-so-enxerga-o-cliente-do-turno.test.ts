/**
 * A1 — um cliente no WhatsApp não consegue, pelo agente, ver nem mexer nos
 * dados de OUTRO cliente.
 *
 * A asserção é sobre a CADEIA que o turno usa: a ferramenta é montada por
 * `pickToolsFromMcp` (a ponte do motor e do runtime nativo) com o ator de IA e
 * o contato do turno, e o que se mede é se o HANDLER foi chamado — e com o quê.
 * O banco falso responde o dono de cada registro como o banco de verdade.
 *
 * O controle é o mesmo turno com ator humano/token: nada muda para eles.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const chamadas = vi.hoisted(() => [] as Array<{ tool: string; args: Record<string, unknown> }>);
const respostas = vi.hoisted(() => ({} as Record<string, unknown>));

vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/mcp/tools", () => {
  const def = (name: string, shape: Record<string, z.ZodTypeAny>, category: "read" | "write") => ({
    name,
    description: name,
    inputSchema: shape,
    category,
    requiresRole: "agent",
    requiresScope: category === "read" ? "mcp:read" : "mcp:write",
    handler: async (args: Record<string, unknown>) => {
      chamadas.push({ tool: name, args });
      return respostas[name] ?? { ok: true };
    },
  });
  const tools = [
    def("crm_get_contact", { contact_id: z.string() }, "read"),
    def("crm_get_lead", { lead_id: z.string() }, "read"),
    def("crm_search_contacts", { query: z.string() }, "read"),
    def("crm_list_leads", { status: z.string().optional() }, "read"),
    def(
      "crm_list_appointments",
      { contact_id: z.string().optional(), lead_id: z.string().optional() },
      "read",
    ),
    def("crm_cancel_appointment", { appointment_id: z.string(), reason: z.string() }, "write"),
    def("crm_get_conversation_history", { conversation_id: z.string() }, "read"),
    def("crm_list_at_risk_leads", { limit: z.number().optional() }, "read"),
    def(
      "crm_manage_tags",
      { target_kind: z.string(), target_id: z.string(), add: z.array(z.string()).optional() },
      "write",
    ),
    def("crm_search_products", { termo: z.string() }, "read"),
  ];
  return { allTools: tools, getToolByName: (n: string) => tools.find((t) => t.name === n) };
});

const { pickToolsFromMcp } = await import("@/lib/ai/runtime/tools");

const ORG = "11111111-1111-4111-8111-111111111111";
const CLIENTE = "22222222-2222-4222-8222-222222222222";
const OUTRO = "99999999-9999-4999-8999-999999999999";
const LEAD_DO_CLIENTE = "33333333-3333-4333-8333-333333333333";
const LEAD_DO_OUTRO = "44444444-4444-4444-8444-444444444444";
const AGENDA_DO_CLIENTE = "55555555-5555-4555-8555-555555555555";
const AGENDA_DO_OUTRO = "66666666-6666-4666-8666-666666666666";
const CONVERSA_DO_CLIENTE = "77777777-7777-4777-8777-777777777777";
const CONVERSA_DO_OUTRO = "88888888-8888-4888-8888-888888888888";

/** O dono de cada registro, como o banco de verdade o guarda. */
const TABELAS: Record<string, Record<string, Record<string, unknown>>> = {
  contacts: { [CLIENTE]: { id: CLIENTE }, [OUTRO]: { id: OUTRO } },
  crm_leads: {
    [LEAD_DO_CLIENTE]: { contact_id: CLIENTE, pipeline_id: "f1" },
    [LEAD_DO_OUTRO]: { contact_id: OUTRO, pipeline_id: "f1" },
  },
  calendar_appointments: {
    [AGENDA_DO_CLIENTE]: { contact_id: CLIENTE },
    [AGENDA_DO_OUTRO]: { contact_id: OUTRO },
  },
  conversations: {
    [CONVERSA_DO_CLIENTE]: { contact_id: CLIENTE },
    [CONVERSA_DO_OUTRO]: { contact_id: OUTRO },
  },
};

function banco(opts: { falha?: boolean } = {}) {
  return {
    from(tabela: string) {
      const filtros: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq: (coluna: string, valor: unknown) => {
          filtros[coluna] = valor;
          return q;
        },
        in: () => q,
        is: () => q,
        maybeSingle: async () => {
          if (opts.falha) return { data: null, error: { message: "timeout" } };
          expect(filtros.organization_id).toBe(ORG);
          const linha = TABELAS[tabela]?.[String(filtros.id)];
          return { data: linha ?? null, error: null };
        },
        then: (ok: (r: unknown) => unknown) => ok({ data: [], error: null }),
      };
      return q;
    },
  };
}

type Ator = "ai_agent" | "api_token";

function montar(opts: { ator?: Ator; contatoDoTurno?: string; falha?: boolean } = {}) {
  const ator =
    opts.ator === "api_token"
      ? { type: "api_token", id: "tok-1", role: "manager" }
      : { type: "ai_agent", id: "ag-1", role: "ai_operator" };
  const supabase = banco({ falha: opts.falha });
  return pickToolsFromMcp({
    toolIds: [
      "crm_get_contact",
      "crm_get_lead",
      "crm_search_contacts",
      "crm_list_leads",
      "crm_list_appointments",
      "crm_cancel_appointment",
      "crm_get_conversation_history",
      "crm_list_at_risk_leads",
      "crm_manage_tags",
      "crm_search_products",
    ],
    auth: {
      organizationId: ORG,
      role: "ai_operator",
      scopes: ["mcp:read", "mcp:write"],
      actor: ator,
      apiTokenId: "tok-1",
    },
    ctx: { organizationId: ORG, role: "ai_operator", actor: ator, apiTokenId: "tok-1", requestId: "req-1", supabase },
    supabase,
    pipelineIds: ["f1"],
    handoffToolEnabled: false,
    handoffSignal: { triggered: false },
    ...(opts.contatoDoTurno ? { contatoDoTurno: opts.contatoDoTurno } : {}),
  } as never);
}

async function chamar(
  ferramentas: ReturnType<typeof montar>,
  nome: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return (await ferramentas[nome]!.execute!(args, { toolCallId: "c1", messages: [] } as never)) as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  chamadas.length = 0;
  for (const k of Object.keys(respostas)) delete respostas[k];
});

describe("turno de IA com contato: só o cliente da conversa", () => {
  it("ler o contato de OUTRO cliente é recusado, com mensagem para o modelo, sem chamar o handler", async () => {
    const r = await chamar(montar({ contatoDoTurno: CLIENTE }), "crm_get_contact", { contact_id: OUTRO });
    expect(r.permitido).toBe(false);
    expect(r.motivo).toBe("outro_cliente");
    expect(String(r.mensagem)).toMatch(/só do cliente desta conversa/);
    expect(chamadas).toEqual([]);
  });

  it("ler o PRÓPRIO contato segue normal", async () => {
    await chamar(montar({ contatoDoTurno: CLIENTE }), "crm_get_contact", { contact_id: CLIENTE });
    expect(chamadas).toEqual([{ tool: "crm_get_contact", args: { contact_id: CLIENTE } }]);
  });

  it("negócio de outro cliente: recusado; do cliente: passa", async () => {
    const f = montar({ contatoDoTurno: CLIENTE });
    expect((await chamar(f, "crm_get_lead", { lead_id: LEAD_DO_OUTRO })).permitido).toBe(false);
    await chamar(f, "crm_get_lead", { lead_id: LEAD_DO_CLIENTE });
    expect(chamadas.map((c) => c.args.lead_id)).toEqual([LEAD_DO_CLIENTE]);
  });

  it("cancelar o compromisso de OUTRO cliente é recusado; o do cliente passa", async () => {
    const f = montar({ contatoDoTurno: CLIENTE });
    const r = await chamar(f, "crm_cancel_appointment", { appointment_id: AGENDA_DO_OUTRO, reason: "x" });
    expect(r.permitido).toBe(false);
    await chamar(f, "crm_cancel_appointment", { appointment_id: AGENDA_DO_CLIENTE, reason: "x" });
    expect(chamadas.map((c) => c.args.appointment_id)).toEqual([AGENDA_DO_CLIENTE]);
  });

  it("id inexistente recebe a MESMA recusa (não confirma a existência de ninguém)", async () => {
    const r = await chamar(montar({ contatoDoTurno: CLIENTE }), "crm_cancel_appointment", {
      appointment_id: "00000000-0000-4000-8000-00000000dead",
      reason: "x",
    });
    expect(r.motivo).toBe("outro_cliente");
  });

  it("histórico de conversa de outro cliente é recusado", async () => {
    const r = await chamar(montar({ contatoDoTurno: CLIENTE }), "crm_get_conversation_history", {
      conversation_id: CONVERSA_DO_OUTRO,
    });
    expect(r.permitido).toBe(false);
    expect(chamadas).toEqual([]);
  });

  it("listar compromissos SEM contato vira listar os do cliente do turno", async () => {
    await chamar(montar({ contatoDoTurno: CLIENTE }), "crm_list_appointments", {});
    expect(chamadas[0]!.args.contact_id).toBe(CLIENTE);
  });

  it("listar compromissos de OUTRO contato é recusado", async () => {
    const r = await chamar(montar({ contatoDoTurno: CLIENTE }), "crm_list_appointments", { contact_id: OUTRO });
    expect(r.permitido).toBe(false);
  });

  it("busca de contatos devolve só o cliente do turno", async () => {
    respostas.crm_search_contacts = {
      contacts: [{ id: OUTRO, name: "Maria" }, { id: CLIENTE, name: "Ana" }],
      cursor: "abc",
      has_more: true,
    };
    const r = await chamar(montar({ contatoDoTurno: CLIENTE }), "crm_search_contacts", { query: "a" });
    expect(r.contacts).toEqual([{ id: CLIENTE, name: "Ana" }]);
    expect(r.has_more).toBe(false);
  });

  it("listagem de negócios é recortada para o contato do turno", async () => {
    respostas.crm_list_leads = {
      leads: [
        { id: LEAD_DO_OUTRO, contact_id: OUTRO },
        { id: LEAD_DO_CLIENTE, contact_id: CLIENTE },
      ],
    };
    const r = await chamar(montar({ contatoDoTurno: CLIENTE }), "crm_list_leads", {});
    expect(r.leads).toEqual([{ id: LEAD_DO_CLIENTE, contact_id: CLIENTE }]);
  });

  it("ferramenta que só enxerga a base inteira fica fora do atendimento", async () => {
    const r = await chamar(montar({ contatoDoTurno: CLIENTE }), "crm_list_at_risk_leads", {});
    expect(r.motivo).toBe("fora_do_atendimento");
    expect(chamadas).toEqual([]);
  });

  it("marcador em contato/negócio de outro cliente é recusado", async () => {
    const f = montar({ contatoDoTurno: CLIENTE });
    expect(
      (await chamar(f, "crm_manage_tags", { target_kind: "lead", target_id: LEAD_DO_OUTRO, add: ["vip"] }))
        .permitido,
    ).toBe(false);
    await chamar(f, "crm_manage_tags", { target_kind: "contact", target_id: CLIENTE, add: ["vip"] });
    expect(chamadas).toHaveLength(1);
  });

  it("ferramenta livre (catálogo) segue livre", async () => {
    await chamar(montar({ contatoDoTurno: CLIENTE }), "crm_search_products", { termo: "x" });
    expect(chamadas).toHaveLength(1);
  });

  it("falha ao conferir o dono recusa (na dúvida o agente age de menos)", async () => {
    const r = await chamar(montar({ contatoDoTurno: CLIENTE, falha: true }), "crm_get_lead", {
      lead_id: LEAD_DO_CLIENTE,
    });
    expect(r.motivo).toBe("indisponivel");
    expect(chamadas).toEqual([]);
  });
});

describe("controle: quem não é o agente num atendimento não é afetado", () => {
  it("token de integração (ator não-IA) lê qualquer contato da organização", async () => {
    await chamar(montar({ ator: "api_token", contatoDoTurno: CLIENTE }), "crm_get_contact", {
      contact_id: OUTRO,
    });
    expect(chamadas).toEqual([{ tool: "crm_get_contact", args: { contact_id: OUTRO } }]);
  });

  it("agente sem contato no turno (ensaio sem conversa) segue como antes", async () => {
    await chamar(montar({}), "crm_get_contact", { contact_id: OUTRO });
    expect(chamadas).toHaveLength(1);
  });
});
