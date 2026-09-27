/**
 * A4 — escopos de token por lista FECHADA, e papel que não passa o de quem cria.
 *
 * Antes `scopes` era `z.array(z.string())`: dava para gravar `actor:ai_agent`
 * e `agent_run:<id>` num token humano (e se passar pelo agente publicado no
 * audit, na FK de atividade e no gate de canal) ou `role:ai_operator`, papel
 * que nenhuma pessoa tem.
 */
import { describe, expect, it } from "vitest";

import {
  createApiTokenSchema,
  ESCOPOS_DE_TOKEN_CONCEDIVEIS,
  papelDoToken,
  papelDoTokenCabeNoCriador,
} from "./team";

const ok = (scopes: string[], name = "Integração n8n") =>
  createApiTokenSchema.safeParse({ name, scopes }).success;

describe("createApiTokenSchema — escopos concedíveis", () => {
  it("aceita os escopos da tela", () => {
    expect(ok(["mcp:read", "mcp:write", "role:manager"])).toBe(true);
    expect(ok(["contacts:read", "messages:on_behalf", "audit:read"])).toBe(true);
  });

  it("recusa os escopos que são do servidor", () => {
    expect(ok(["mcp:read", "actor:ai_agent"])).toBe(false);
    expect(ok(["mcp:read", "agent_run:0e7b5f7e-0000-4000-8000-000000000001"])).toBe(false);
    expect(ok(["mcp:read", "role:ai_operator"])).toBe(false);
    expect(ok(["mcp:read", "integration:clinicfx"])).toBe(false);
  });

  it("recusa texto livre e papel inventado", () => {
    expect(ok(["qualquer-coisa"])).toBe(false);
    expect(ok(["role:superadmin"])).toBe(false);
  });

  it("no máximo um papel por token", () => {
    expect(ok(["mcp:read", "role:agent", "role:manager"])).toBe(false);
  });

  it("o nome `agent-run:` é reservado ao token efêmero do agente", () => {
    expect(ok(["mcp:read"], "agent-run:abc")).toBe(false);
    expect(ok(["mcp:read"], " Agent-Run:abc")).toBe(false);
    expect(ok(["mcp:read"], "meu agent-run")).toBe(true);
  });

  it("a lista fechada não tem nenhum escopo reservado do servidor", () => {
    for (const e of ESCOPOS_DE_TOKEN_CONCEDIVEIS) {
      expect(e).not.toMatch(/^(actor:|agent_run:|integration:|role:ai_operator)/);
    }
  });
});

describe("papel do token cabe no de quem cria", () => {
  it("lê o primeiro role:, e agent por padrão", () => {
    expect(papelDoToken(["mcp:read"])).toBe("agent");
    expect(papelDoToken(["role:manager"])).toBe("manager");
  });

  it("admin concede até admin; manager não concede admin; papel desconhecido não concede nada", () => {
    expect(papelDoTokenCabeNoCriador(["role:admin"], "admin")).toBe(true);
    expect(papelDoTokenCabeNoCriador(["role:manager"], "manager")).toBe(true);
    expect(papelDoTokenCabeNoCriador(["role:admin"], "manager")).toBe(false);
    expect(papelDoTokenCabeNoCriador(["mcp:read"], "viewer")).toBe(false); // agent > viewer
    expect(papelDoTokenCabeNoCriador(["role:viewer"], "viewer")).toBe(true);
    expect(papelDoTokenCabeNoCriador(["role:viewer"], null)).toBe(false);
  });
});
