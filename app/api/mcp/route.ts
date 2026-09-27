/**
 * MCP server endpoint (Spec 11 §2 + §5.4).
 *
 * Streamable HTTP transport via `WebStandardStreamableHTTPServerTransport`
 * (Next.js App Router recebe Web `Request`). Stateless: cada request abre
 * um transport+server fresh. Auth via Bearer (`api_tokens`).
 *
 * NUNCA logamos plaintext do bearer. Em erro retornamos JSON-RPC 2.0
 * envelope com `error.code` MCP (-32001/-32002/etc).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { createMcpServer } from "@/lib/mcp/server";
import { McpAuthError, validateBearerToken } from "@/lib/mcp/auth";
import { modulosLigados } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { chaveDaRequisicao } from "@/lib/api/idempotency";
import { logger } from "@/lib/logger";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/** Falha inesperada: o cliente recebe só o `request_id`; o detalhe fica no log. */
function internalErrorMessage(requestId: string): string {
  return `Internal error. If it persists, report request_id ${requestId}.`;
}

function jsonRpcError(code: number, message: string, status: number, requestId?: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message, ...(requestId ? { data: { request_id: requestId } } : {}) },
      id: null,
    }),
    {
      status,
      headers: {
        "content-type": "application/json",
        ...(requestId ? { "X-Request-Id": requestId } : {}),
      },
    },
  );
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  let auth;
  try {
    auth = await validateBearerToken(req.headers.get("authorization"));
  } catch (err) {
    if (err instanceof McpAuthError) {
      // Um 5xx de McpAuthError é falha NOSSA de consulta (`lookup_failed`), e a
      // mensagem dele carrega o texto do banco: vai ao log, não ao cliente.
      if (err.httpStatus >= 500) {
        logger.error("mcp.auth.lookup_failed", { request_id: requestId, error: err.message });
        return jsonRpcError(err.mcpCode, internalErrorMessage(requestId), err.httpStatus, requestId);
      }
      return jsonRpcError(err.mcpCode, err.message, err.httpStatus, requestId);
    }
    logger.error("mcp.auth.unexpected_error", {
      request_id: requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonRpcError(-32603, internalErrorMessage(requestId), 500, requestId);
  }

  const idempotencyKey = chaveDaRequisicao(req);
  if (idempotencyKey !== null && !z.string().uuid().safeParse(idempotencyKey).success) {
    return jsonRpcError(-32602, "Idempotency-Key deve ser UUID", 400, requestId);
  }

  const transport = new WebStandardStreamableHTTPServerTransport({});
  const server = createMcpServer(
    auth,
    requestId,
    await modulosLigados(createAdminClient()),
    idempotencyKey ?? undefined,
  );

  try {
    await server.connect(transport);
    const response = await transport.handleRequest(req as unknown as Request);
    response.headers.set("X-Request-Id", requestId);
    return response;
  } catch (err) {
    logger.error("mcp.transport.unexpected_error", {
      request_id: requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonRpcError(-32603, internalErrorMessage(requestId), 500, requestId);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function DELETE(req: NextRequest): Promise<Response> {
  return handle(req);
}
