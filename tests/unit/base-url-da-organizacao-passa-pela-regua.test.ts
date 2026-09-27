import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Auditoria P4 (`docs/imobiliario/04-auditoria-seguranca-e-qualidade.md`).
 *
 * O `base_url` de provedor de IA é escolha de uma ORGANIZAÇÃO, e quem chama é
 * o servidor, levando a chave. Só o provedor `custom` passava pela régua de
 * destino; openrouter, deepseek, requesty e o embedding seguiam para qualquer
 * endereço — `http://10.0.0.5`, o metadado de nuvem, os serviços do compose.
 *
 * O critério é COMPORTAMENTO: o `fetch` global (a rede) NÃO pode ser chamado
 * quando o endereço é interno. Um guard que só lançasse depois deixaria a
 * chave sair na mesma.
 */

vi.mock("node:dns/promises", () => {
  const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
  return { lookup, default: { lookup } };
});

const chaveRef: { current: unknown } = { current: null };
vi.mock("@/lib/ai/embeddings/chave", async () => {
  const real =
    await vi.importActual<typeof import("@/lib/ai/embeddings/chave")>("@/lib/ai/embeddings/chave");
  return { ...real, resolverChaveDeEmbedding: async () => chaveRef.current };
});

import type { LanguageModel } from "ai";

import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { embedText } from "@/lib/ai/embed";
import { instanciar } from "@/lib/ai/gateway-binding";

const INTERNO = "http://10.0.0.5/v1";
const rede = vi.fn();

beforeEach(() => {
  rede.mockReset();
  rede.mockResolvedValue(
    new Response(JSON.stringify({ error: "não deveria chegar aqui" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", rede);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function gerar(model: LanguageModel | null): Promise<unknown> {
  const m = model as unknown as {
    doGenerate: (o: unknown) => Promise<unknown>;
  };
  return m.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "oi" }] }],
    maxRetries: 0,
  });
}

describe("motor do agente (createDefaultRegistry)", () => {
  const reg = createDefaultRegistry();
  for (const provedor of ["openrouter", "deepseek", "requesty"] as const) {
    it(`${provedor} com base_url interno: recusa sem tocar a rede`, async () => {
      await expect(gerar(reg[provedor]!("sk-org", "m", INTERNO))).rejects.toThrow(/unsafe_url/);
      expect(rede).not.toHaveBeenCalled();
    });
  }
});

describe("pilha dos workers (gateway-binding)", () => {
  for (const provedor of ["openrouter", "deepseek", "requesty"] as const) {
    it(`${provedor} com base_url interno: recusa sem tocar a rede`, async () => {
      await expect(gerar(instanciar(provedor, "sk-org", "m", INTERNO))).rejects.toThrow(/unsafe_url/);
      expect(rede).not.toHaveBeenCalled();
    });
  }

  it("sem base_url, o endpoint do fabricante segue sem a régua (vacuidade)", async () => {
    await gerar(instanciar("deepseek", "sk-org", "m", null)).catch(() => undefined);
    expect(rede).toHaveBeenCalled();
    expect(String(rede.mock.calls[0]![0])).toContain("api.deepseek.com");
  });
});

describe("embedding da base de conhecimento", () => {
  it("base_url interno do binding: recusa sem tocar a rede", async () => {
    chaveRef.current = {
      apiKey: "sk-org",
      baseUrl: INTERNO,
      viaGateway: false,
      origem: "binding_do_ponto",
      rotulo: "x",
      avisos: [],
    };
    await expect(embedText("texto", { organizationId: "org-1" })).rejects.toThrow(/unsafe_url/);
    expect(rede).not.toHaveBeenCalled();
  });
});
