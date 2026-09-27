/**
 * O que um erro de ferramenta MCP pode dizer a quem chamou.
 *
 * O `catch` do servidor MCP devolvia `err.message` cru. Quando o erro vinha do
 * banco, o cliente (um modelo, ou uma integração externa) lia nomes de tabela,
 * de coluna e de constraint — `duplicate key value violates unique constraint
 * "uniq_contacts_org_cpf"` — e o texto ainda ia parar no contexto do modelo.
 *
 * A regra separa DUAS famílias:
 *
 * - **Recusa pensada para quem lê** — passa como está, porque é instrução:
 *   `McpAuthError` (papel, escopo, teto), `ApiError` que não é 500 (os
 *   handlers escrevem a mensagem para o usuário), `ZodError` (entrada inválida) e o `Error`
 *   comum que as ferramentas lançam com orientação ao modelo ("informe ao
 *   menos uma tag", `case_not_found`).
 * - **Falha inesperada** — vira mensagem genérica com `request_id`, e o texto
 *   original vai só para o log estruturado: `ApiError` 500 (os handlers põem
 *   ali o `error.message` do PostgREST), erro que carrega código do Postgres /
 *   PostgREST, mensagem com a assinatura de erro de banco ou de rede, e
 *   qualquer coisa lançada que não seja `Error`.
 *
 * A assinatura é lista, não prova: um `Error` comum com texto de banco que não
 * case com ela passa. Por isso a lista mira o que o PostgREST e o Postgres
 * efetivamente escrevem.
 */
import { ZodError } from "zod";

import { ApiError } from "@/lib/api/types";

import { McpAuthError } from "./auth";

/** SQLSTATE (5 caracteres) ou código do PostgREST (`PGRST116`). */
const CODIGO_DE_BANCO = /^(?:[0-9A-Z]{5}|PGRST\d+)$/;

const ASSINATURA_DE_BANCO =
  /violates|duplicate key|relation "|column "|constraint "|syntax error|invalid input syntax|permission denied|does not exist|PGRST\d|JSON object requested|could not (?:serialize|connect)|deadlock|canceling statement|connection (?:reset|refused|terminated)|ECONN|ETIMEDOUT|fetch failed|socket hang up|timeout exceeded|null value in column/i;

export interface ErroTraduzido {
  /** O texto que o cliente vê. */
  mensagem: string;
  /** `true` quando o texto original foi escondido (e deve ir ao log). */
  inesperado: boolean;
  /** O texto original — só para log e auditoria interna, nunca para o cliente. */
  original: string;
}

function mensagemGenerica(requestId: string): string {
  return `Internal error while running the tool. Try again later; if it persists, report request_id ${requestId}.`;
}

export function erroParaOCliente(err: unknown, requestId: string): ErroTraduzido {
  if (err instanceof McpAuthError) {
    return { mensagem: err.message, inesperado: false, original: err.message };
  }
  if (err instanceof ApiError) {
    // Só o 500 (`internal_error`) é "inesperado": é onde os handlers põem o
    // `error.message` do PostgREST. 503/422/409… são recusas escritas para
    // quem lê (`cpf_encryption_unavailable`, `waha_not_configured`).
    return err.status === 500 || err.code === "internal_error"
      ? { mensagem: mensagemGenerica(requestId), inesperado: true, original: err.message }
      : { mensagem: err.message, inesperado: false, original: err.message };
  }
  if (err instanceof ZodError) {
    const primeira = err.issues[0];
    const onde = primeira?.path?.length ? `${primeira.path.join(".")}: ` : "";
    const texto = `Invalid input — ${onde}${primeira?.message ?? "invalid value"}`;
    return { mensagem: texto, inesperado: false, original: err.message };
  }
  if (err instanceof Error) {
    const codigo = (err as { code?: unknown }).code;
    // `PTnnn` é o SQLSTATE das recusas que as NOSSAS funções escrevem para quem
    // lê (ex.: o teto de tokens, PT409) — mensagem pensada, não vazamento.
    const temCodigoDeBanco =
      typeof codigo === "string" && CODIGO_DE_BANCO.test(codigo) && !codigo.startsWith("PT");
    if (temCodigoDeBanco || ASSINATURA_DE_BANCO.test(err.message)) {
      return { mensagem: mensagemGenerica(requestId), inesperado: true, original: err.message };
    }
    return { mensagem: err.message, inesperado: false, original: err.message };
  }
  const original = (() => {
    try {
      return typeof err === "string" ? err : JSON.stringify(err);
    } catch {
      return String(err);
    }
  })();
  return { mensagem: mensagemGenerica(requestId), inesperado: true, original };
}
