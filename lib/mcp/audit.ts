/**
 * Audit log dedicado para tool calls MCP.
 *
 * Spec 11 §6: cada tool call gera 1 entrada em `api_audit_log` com
 * `action='mcp.tool_called'`, `actor_type='ai_agent'` (quando aplicavel),
 * `actor_api_token_id=<token>` (o efêmero do agente só no metadata — ver
 * `tokenNaAuditoria`), `resource_type='mcp_tool'`, `resource_id=<tool_name>`.
 *
 * Fire-and-forget: falha de write nunca bloqueia retorno da tool.
 */
import { audit } from "@/lib/audit";
import type { McpContext } from "./types";

interface AuditMcpToolCallInput {
  ctx: McpContext;
  toolName: string;
  args: Record<string, unknown>;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
  resultSummary?: string;
  /**
   * Vazio DECLARADO pela tool ("não achei"), quando o `success: false` é isso e
   * não erro técnico. A tool diz qual vazio foi (`motivo`).
   *
   * O painel conta a chamada como falha por `metadata->>'success' = 'false'`
   * (`fn_agent_tool_usage`, migration 0103) e não precisa saber mais nada para
   * parar de dizer "nenhuma falha". Estes dois campos são o que separa
   * "a busca não achou" de "a busca quebrou" no dado gravado; separar os dois na
   * TELA pede um contador novo naquela função — migration, trabalho do mantenedor.
   */
  desfecho?: "sem_resultado";
  motivo?: string;
}

const ARGS_REDACT_KEYS = new Set([
  "authorization",
  "api_key",
  "token",
  "password",
  "cpf",
]);

function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (ARGS_REDACT_KEYS.has(k.toLowerCase())) {
      out[k] = "[redacted]";
    } else if (typeof v === "string" && v.length > 500) {
      out[k] = `${v.slice(0, 500)}...[truncated]`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Como o token de quem chamou entra numa linha de auditoria.
 *
 * Token comum (de pessoa ou de integração): na coluna `actor_api_token_id`, com
 * FK — é o que liga a ação à chave, e a chave dura.
 *
 * Token EFÊMERO do turno do agente (`ctx.tokenEfemero`): só em
 * `metadata.actor_api_token_id`. Ele vale 5 minutos e existe um por turno; a
 * coluna com FK impedia a poda de apagá-lo (a poda não toca token citado pela
 * auditoria, porque o `ON DELETE SET NULL` reescreveria a linha), e cada turno
 * deixava uma linha em `api_tokens` para sempre. O vínculo com o turno não se
 * perde: `metadata.actor_id` é o run, e o id do token segue no metadata.
 */
export function tokenNaAuditoria(ctx: Pick<McpContext, "apiTokenId" | "tokenEfemero">): {
  actorApiTokenId: string | null;
  metadata: Record<string, unknown>;
} {
  if (ctx.tokenEfemero) {
    return { actorApiTokenId: null, metadata: { actor_api_token_id: ctx.apiTokenId } };
  }
  return { actorApiTokenId: ctx.apiTokenId, metadata: {} };
}

export async function auditMcpToolCall(input: AuditMcpToolCallInput): Promise<void> {
  const { ctx, toolName, args, durationMs, success, errorMessage, resultSummary, desfecho, motivo } =
    input;

  const metadata: Record<string, unknown> = {
    actor_type: ctx.actor.type,
    actor_id: ctx.actor.id,
    tool_name: toolName,
    args: redactArgs(args),
    duration_ms: durationMs,
    success,
  };

  if (resultSummary) metadata.result_summary = resultSummary.slice(0, 280);
  if (errorMessage) metadata.error = errorMessage.slice(0, 500);
  if (desfecho) metadata.desfecho = desfecho;
  if (motivo) metadata.motivo = motivo.slice(0, 200);
  if (ctx.actor.type === "ai_agent" && ctx.actor.api_token_id) {
    metadata.actor_api_token_id = ctx.actor.api_token_id;
  }
  const token = tokenNaAuditoria(ctx);
  Object.assign(metadata, token.metadata);

  await audit({
    action: "mcp.tool_called",
    // Quem age via MCP é um TOKEN, nunca uma linha de auth.users: para um token
    // comum, ctx.actor.id é o id do próprio token (lib/mcp/auth.ts), e mandá-lo
    // como actorUserId estourava a FK api_audit_log_actor_user_id_fkey. O ator
    // já fica registrado em actorApiTokenId e em metadata.actor_id.
    actorUserId: null,
    // Token efêmero do agente: só no metadata (ver `tokenNaAuditoria`).
    actorApiTokenId: token.actorApiTokenId,
    organizationId: ctx.organizationId,
    resourceType: "mcp_tool",
    // `resource_id` é uuid no banco; o nome da tool ia aqui como texto e o
    // insert morria com "invalid input syntax for type uuid: crm_create_lead".
    // O nome já viaja em metadata.tool_name, que é jsonb.
    resourceId: null,
    requestId: ctx.requestId,
    metadata,
  });
}
