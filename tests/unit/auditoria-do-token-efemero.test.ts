/**
 * R3 — a auditoria não prende o token efêmero do agente.
 *
 * Cada turno do agente cunha um token `agent-run:<run>` que vale 5 minutos. A
 * poda diária (`app/api/v1/cron/data-retention`, `podaDeTokensSobre`) só apaga
 * token que a auditoria NÃO cita — `api_audit_log.actor_api_token_id` é
 * `ON DELETE SET NULL`, e apagar um token citado reescreveria a auditoria. Mas
 * `auditMcpToolCall` gravava o token na coluna com FK em TODA tool chamada, e
 * todo turno chama tool: a poda nunca achava um efêmero para apagar.
 *
 * Agora o efêmero (marcado pelo runtime que o cunha, `ctx.tokenEfemero`) vai só
 * para `metadata.actor_api_token_id`; token de pessoa ou integração continua na
 * coluna com FK.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { audit } from "@/lib/audit";
import { auditMcpToolCall, tokenNaAuditoria } from "@/lib/mcp/audit";
import type { McpContext } from "@/lib/mcp/types";

const ORG = "eeeeeeee-0000-4000-8000-000000000001";
const TOKEN = "eeeeeeee-0000-4000-8000-0000000000t1";
const RUN = "eeeeeeee-0000-4000-8000-0000000000r1";

function ctxDoAgente(tokenEfemero: boolean): McpContext {
  return {
    organizationId: ORG,
    role: "ai_operator",
    actor: { type: "ai_agent", id: RUN, role: "ai_operator", api_token_id: TOKEN },
    apiTokenId: TOKEN,
    ...(tokenEfemero ? { tokenEfemero: true } : {}),
    requestId: RUN,
    supabase: {} as never,
  } as McpContext;
}

function ctxDeIntegracao(): McpContext {
  return {
    organizationId: ORG,
    role: "manager",
    actor: { type: "api_token", id: TOKEN, role: "manager" },
    apiTokenId: TOKEN,
    requestId: "req-1",
    supabase: {} as never,
  } as McpContext;
}

function ultimaEntrada() {
  const chamadas = vi.mocked(audit).mock.calls;
  return chamadas[chamadas.length - 1]![0] as {
    actorApiTokenId: string | null;
    metadata: Record<string, unknown>;
  };
}

beforeEach(() => {
  vi.mocked(audit).mockClear();
});

describe("auditMcpToolCall — token efêmero x token durável", () => {
  it("tool chamada pelo agente com token efêmero: FK nula, id do token no metadata", async () => {
    await auditMcpToolCall({
      ctx: ctxDoAgente(true),
      toolName: "crm_get_contact",
      args: {},
      durationMs: 3,
      success: true,
    });
    const e = ultimaEntrada();
    expect(e.actorApiTokenId).toBeNull();
    expect(e.metadata.actor_api_token_id).toBe(TOKEN);
    expect(e.metadata.actor_id).toBe(RUN);
  });

  it("token de integração (durável) continua na coluna com FK", async () => {
    await auditMcpToolCall({
      ctx: ctxDeIntegracao(),
      toolName: "crm_get_contact",
      args: {},
      durationMs: 3,
      success: true,
    });
    expect(ultimaEntrada().actorApiTokenId).toBe(TOKEN);
  });

  it("agente pelo MCP externo, sem a marca de efêmero, mantém a FK (o lado seguro)", async () => {
    await auditMcpToolCall({
      ctx: ctxDoAgente(false),
      toolName: "crm_get_contact",
      args: {},
      durationMs: 3,
      success: true,
    });
    expect(ultimaEntrada().actorApiTokenId).toBe(TOKEN);
  });

  it("tokenNaAuditoria é a mesma régua para as auditorias próprias das tools", () => {
    expect(tokenNaAuditoria(ctxDoAgente(true))).toEqual({
      actorApiTokenId: null,
      metadata: { actor_api_token_id: TOKEN },
    });
    expect(tokenNaAuditoria(ctxDeIntegracao())).toEqual({ actorApiTokenId: TOKEN, metadata: {} });
  });
});

// ─── Catracas de fonte ────────────────────────────────────────────────────────

const RAIZ = join(__dirname, "..", "..");

function arquivos(dir: string, saida: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    if (nome === "node_modules" || nome.startsWith(".")) continue;
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) arquivos(caminho, saida);
    else if (/\.tsx?$/.test(nome) && !/\.test\.tsx?$/.test(nome)) saida.push(caminho);
  }
  return saida;
}

describe("catracas — nenhuma auditoria de tool grava o efêmero na FK", () => {
  it("nenhuma tool MCP passa `actorApiTokenId: ctx.apiTokenId` direto (usa tokenNaAuditoria)", () => {
    const diretos = arquivos(join(RAIZ, "lib", "mcp", "tools"))
      .filter((c) => /actorApiTokenId:\s*ctx\.apiTokenId/.test(readFileSync(c, "utf8")))
      .map((c) => relative(RAIZ, c));
    expect(diretos).toEqual([]);
  });

  it("todo runtime que cunha o token efêmero marca o contexto como efêmero", () => {
    const cunham = ["lib", "workers", "app"]
      .flatMap((d) => arquivos(join(RAIZ, d)))
      .filter((c) => readFileSync(c, "utf8").includes("mintEphemeralToken("))
      .filter((c) => !c.endsWith(join("runtime", "mcp_token.ts")));
    expect(cunham.map((c) => relative(RAIZ, c)).sort()).toEqual([
      "lib/agent-engine/edge/crm/mcp-tools.ts",
      "lib/ai/runtime/agent.ts",
    ]);
    for (const c of cunham) {
      expect(readFileSync(c, "utf8"), relative(RAIZ, c)).toMatch(/tokenEfemero:\s*true/);
    }
  });
});
