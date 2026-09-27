/**
 * A10 — a rota `/api/mcp` não devolve texto interno em falha inesperada.
 *
 * Dois pontos devolviam `err.message` cru: a autenticação (inclusive o
 * `lookup_failed`, cuja mensagem carrega o erro do banco) e o transporte.
 * Agora o cliente recebe mensagem genérica com `request_id` (no corpo e no
 * `X-Request-Id`), e o detalhe vai ao logger estruturado.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const logSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", () => ({
  logger: { error: logSpy, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
const validar = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mcp/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/mcp/auth")>();
  return { ...real, validateBearerToken: validar };
});

import { McpAuthError } from "@/lib/mcp/auth";
import { POST } from "@/app/api/mcp/route";

async function chamar() {
  const res = await POST(
    new NextRequest("http://localhost/api/mcp", { method: "POST", body: "{}" }),
  );
  const corpo = (await res.json()) as { error: { message: string; data?: { request_id?: string } } };
  return { res, corpo };
}

beforeEach(() => {
  logSpy.mockClear();
  validar.mockReset();
});

describe("rota /api/mcp — falha inesperada", () => {
  it("erro inesperado na autenticação: genérico com request_id; detalhe só no log", async () => {
    validar.mockRejectedValue(new Error('relation "api_tokens" does not exist'));
    const { res, corpo } = await chamar();
    expect(res.status).toBe(500);
    expect(corpo.error.message).not.toContain("api_tokens");
    const id = res.headers.get("X-Request-Id");
    expect(id).toBeTruthy();
    expect(corpo.error.message).toContain(id!);
    expect(corpo.error.data?.request_id).toBe(id);
    expect(logSpy).toHaveBeenCalledWith(
      "mcp.auth.unexpected_error",
      expect.objectContaining({ error: 'relation "api_tokens" does not exist' }),
    );
  });

  it("lookup_failed (500) também não leva o texto do banco", async () => {
    validar.mockRejectedValue(new McpAuthError(-32603, 500, "Token lookup failed: connection reset"));
    const { res, corpo } = await chamar();
    expect(res.status).toBe(500);
    expect(corpo.error.message).not.toContain("connection reset");
  });

  it("recusa de autenticação (401) segue dizendo o porquê (controle)", async () => {
    validar.mockRejectedValue(new McpAuthError(-32001, 401, "Token revoked."));
    const { res, corpo } = await chamar();
    expect(res.status).toBe(401);
    expect(corpo.error.message).toBe("Token revoked.");
    expect(logSpy).not.toHaveBeenCalled();
  });
});
