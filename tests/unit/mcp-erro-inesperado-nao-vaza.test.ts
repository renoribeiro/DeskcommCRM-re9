import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * A10 — o servidor MCP não devolve ao cliente a mensagem crua de uma falha
 * inesperada.
 *
 * O `catch` do servidor devolvia `err.message` como veio. Com erro de banco, o
 * cliente (um modelo, ou a integração de alguém) lia nome de tabela, de coluna e
 * de constraint. Agora: recusa pensada para quem lê passa inteira (é instrução),
 * e falha inesperada vira texto genérico com o `request_id` — o original vai
 * para o log estruturado e para a auditoria interna.
 */
const auditSpy = vi.fn();
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: (e: unknown) => auditSpy(e) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
const logSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", () => ({
  logger: { error: logSpy, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const lancar = vi.hoisted(() => ({ erro: new Error("x") as unknown }));
vi.mock("@/lib/mcp/tools", () => ({
  allTools: [
    {
      name: "ferramenta_que_falha",
      description: "falha",
      inputSchema: { termo: z.string() },
      requiresRole: "viewer",
      requiresScope: "mcp:read",
      handler: async () => {
        throw lancar.erro;
      },
    },
  ],
}));

const { createMcpServer } = await import("@/lib/mcp/server");
const { ApiError } = await import("@/lib/api/types");
const { erroParaOCliente } = await import("@/lib/mcp/erro-para-o-cliente");

const REQ = "req-a10";

async function chamar(): Promise<string> {
  const server = createMcpServer(
    {
      organizationId: "00000000-0000-4000-8000-000000000001",
      role: "admin",
      actor: { type: "user", id: "00000000-0000-4000-8000-000000000002" },
      apiTokenId: "tok",
      scopes: ["mcp:read"],
    },
    REQ,
  );
  const [cliente, servidor] = InMemoryTransport.createLinkedPair();
  await server.connect(servidor);
  const client = new Client({ name: "teste", version: "0.0.0" });
  await client.connect(cliente);
  const r = (await client.callTool({ name: "ferramenta_que_falha", arguments: { termo: "x" } })) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  await client.close();
  expect(r.isError).toBe(true);
  return r.content[0]!.text;
}

const ERRO_DE_BANCO =
  'duplicate key value violates unique constraint "uniq_contacts_org_cpf"';

beforeEach(() => {
  auditSpy.mockClear();
  logSpy.mockClear();
});

describe("servidor MCP — falha inesperada não vaza", () => {
  it("erro de banco vira texto genérico com request_id; o original vai ao log e à auditoria", async () => {
    lancar.erro = new Error(ERRO_DE_BANCO);
    const texto = await chamar();
    expect(texto).not.toContain("uniq_contacts_org_cpf");
    expect(texto).not.toContain("violates");
    expect(texto).toContain(REQ);
    expect(logSpy).toHaveBeenCalledWith(
      "mcp.tool.unexpected_error",
      expect.objectContaining({ request_id: REQ, error: ERRO_DE_BANCO }),
    );
    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ errorMessage: ERRO_DE_BANCO }));
  });

  it("ApiError 500 (os handlers põem ali o error.message do PostgREST) também não vaza", async () => {
    lancar.erro = new ApiError(500, "internal_error", undefined, REQ, 'column "cpf" does not exist');
    const texto = await chamar();
    expect(texto).not.toContain("column");
    expect(texto).toContain(REQ);
  });

  it("recusa escrita para quem lê passa inteira (controle)", async () => {
    lancar.erro = new ApiError(404, "not_found", undefined, REQ, "Contato não encontrado.");
    expect(await chamar()).toBe("Contato não encontrado.");
    lancar.erro = new Error("informe ao menos uma tag em add ou remove");
    expect(await chamar()).toBe("informe ao menos uma tag em add ou remove");
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("erroParaOCliente — a régua", () => {
  it("erro com SQLSTATE é inesperado; PTnnn (recusa nossa) não", () => {
    const pg = Object.assign(new Error("algo"), { code: "23505" });
    expect(erroParaOCliente(pg, REQ).inesperado).toBe(true);
    const nosso = Object.assign(new Error("Limite de 50 tokens ativos."), { code: "PT409" });
    expect(erroParaOCliente(nosso, REQ)).toMatchObject({
      inesperado: false,
      mensagem: "Limite de 50 tokens ativos.",
    });
  });

  it("503 escrito para quem lê passa; coisa que não é Error vira genérico", () => {
    const e = new ApiError(503, "cpf_encryption_unavailable", undefined, REQ, "Sem chave de CPF.");
    expect(erroParaOCliente(e, REQ).mensagem).toBe("Sem chave de CPF.");
    expect(erroParaOCliente({ message: "relation x" }, REQ).inesperado).toBe(true);
  });

  it("ZodError vira mensagem de entrada inválida com o campo", () => {
    const r = z.object({ id: z.string().uuid() }).safeParse({ id: "x" });
    const t = erroParaOCliente(r.error, REQ);
    expect(t.inesperado).toBe(false);
    expect(t.mensagem).toMatch(/^Invalid input — id:/);
  });
});
