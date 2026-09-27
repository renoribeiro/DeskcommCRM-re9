/**
 * Bearer-token auth para o MCP server.
 *
 * Reutiliza `api_tokens` (EPIC-01 / Spec 01 §api-tokens). Plain bearer
 * (`dsk_<prefix>_<secret>`) e hashado SHA256 e batido contra `token_hash`.
 * Nunca logamos plaintext (Sentry beforeSend strip ja cobre `authorization`).
 *
 * Atributos extras (actor_type, agent_run_id, role) ficam em `scopes`
 * como tokens convencionais, sem migration:
 *   `role:manager`     -> role override (default `agent`)
 *   `actor:ai_agent`   -> marca actor_type (default `user`)
 *   `agent_run:<uuid>` -> vincula tool_call ao run (Spec 10)
 *   `mcp:read`         -> habilita read tools desta wave
 *   `mcp:write`        -> habilita write tools (S-13.04)
 */
import { createHash } from "node:crypto";

import type { Actor } from "@/lib/api/handlers/types";
import { registrarFalhaDeToken, tokenFailureLimited } from "@/lib/auth/rate-limit";
import type { Role } from "@/lib/auth/types";
import { ROLE_RANK } from "@/lib/auth/types";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export interface McpAuthResult {
  organizationId: string;
  role: Role;
  actor: Actor;
  apiTokenId: string;
  scopes: string[];
}

export class McpAuthError extends Error {
  constructor(
    public readonly mcpCode: number,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "McpAuthError";
  }
}

const VALID_ROLES = new Set<Role>(["viewer", "agent", "ai_operator", "manager", "admin"]);

function parseScopes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is string => typeof s === "string");
}

function scopesRole(scopes: string[]): Role {
  for (const s of scopes) {
    if (s.startsWith("role:")) {
      const r = s.slice("role:".length) as Role;
      if (VALID_ROLES.has(r)) return r;
    }
  }
  return "agent";
}

/**
 * Exportada para teste: é a função que decide se quem chamou é uma pessoa, um
 * agente ou uma integração — e essa decisão vira coluna com FK e vira gate de
 * canal. Uma regressão aqui não aparece como erro de tipo em lugar nenhum.
 */
export function deriveActor(scopes: string[], tokenId: string): Actor {
  const isAiAgent = scopes.includes("actor:ai_agent");
  const role = scopesRole(scopes);
  if (isAiAgent) {
    const runScope = scopes.find((s) => s.startsWith("agent_run:"));
    const runId = runScope ? runScope.slice("agent_run:".length) : tokenId;
    return { type: "ai_agent", id: runId, role, api_token_id: tokenId };
  }
  // NÃO é `"user"`: um token de servidor é uma integração, e `actor.id` aqui é o
  // id do TOKEN, não de alguém em `auth.users`. Ver o comentário da variante
  // `api_token` em `lib/api/handlers/types.ts` — disfarçá-lo de pessoa quebrava
  // toda FK de `…_by_user_id` e furava o gate de `pre_go_live`.
  return { type: "api_token", id: tokenId, role };
}

export function extractBearer(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!m) return null;
  return m[1]!.trim();
}

/** Por que um `dsk_...` não validou — neutro, sem código MCP nem HTTP status. */
export class ApiTokenError extends Error {
  constructor(
    public readonly reason:
      | "malformed"
      | "not_found"
      | "revoked"
      | "expired"
      | "creator_inactive"
      | "lookup_failed",
    message: string,
  ) {
    super(message);
    this.name = "ApiTokenError";
  }
}

export interface ResolvedApiToken {
  id: string;
  organizationId: string;
  scopes: string[];
  /** `api_tokens.created_by` — quem provisionou o token. `uuid not null` no schema. */
  createdBy: string;
}

/**
 * Núcleo de validação de um bearer `dsk_...`: hash SHA256 → lookup em
 * `api_tokens` → checagem de `revoked_at`/`expires_at`. Extraído de
 * `validateBearerToken` para ser reusado por qualquer consumidor de
 * `api_tokens` que não seja o MCP, SEM herdar a semântica de erro de outro
 * protocolo: quem chama aqui recebe `ApiTokenError` com um `reason` neutro e
 * decide sozinho o que isso vira na resposta dele.
 *
 * Hoje o único consumidor não-MCP passa por `validateBearerToken` e por isso
 * importa `McpAuthError` — ver o cabeçalho de `lib/api/auth-dual.ts`, o helper
 * que deixa uma rota REST aceitar cookie OU bearer. É esse acoplamento que a
 * separação abre caminho para desfazer.
 *
 * Efeito colateral idêntico ao de antes: atualiza `last_used_at`
 * fire-and-forget, depois de todas as validações.
 */
export async function resolveApiToken(plaintext: string): Promise<ResolvedApiToken> {
  if (!plaintext.startsWith("dsk_")) {
    throw new ApiTokenError("malformed", "Invalid token format.");
  }

  const tokenHash = createHash("sha256").update(plaintext).digest();
  const hashLiteral = `\\x${tokenHash.toString("hex")}`;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("api_tokens")
    .select("id, organization_id, scopes, revoked_at, expires_at, created_by")
    .eq("token_hash", hashLiteral)
    .maybeSingle();

  if (error) {
    throw new ApiTokenError("lookup_failed", `Token lookup failed: ${error.message}`);
  }
  if (!data) {
    throw new ApiTokenError("not_found", "Token not recognized.");
  }
  if (data.revoked_at) {
    throw new ApiTokenError("revoked", "Token revoked.");
  }
  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    throw new ApiTokenError("expired", "Token expired.");
  }

  const scopes = parseScopes(data.scopes);

  // ─── O TOKEN VALE ENQUANTO QUEM O CRIOU VALE ──────────────────────────────
  //
  // O token herdava a autoridade de quem o criou e SOBREVIVIA a essa pessoa:
  // um admin removido da organização (ou rebaixado a atendente) seguia
  // operando o CRM como `role:manager` pelo token que emitiu antes de sair.
  // Agora a resolução confere, a cada uso, que `created_by` ainda é membro
  // ATIVO desta organização (`user_organizations.revoked_at is null`) e que o
  // papel dele alcança o `role:` do token.
  //
  // Token de AGENTE (`actor:ai_agent`, o efêmero do turno) confere só a
  // filiação: `role:ai_operator` é papel de máquina, que nenhuma pessoa tem, e
  // o mint (`lib/ai/runtime/mcp_token.ts`) já escolhe um membro ativo.
  const { data: membro, error: membroErr } = await supabase
    .from("user_organizations")
    .select("role")
    .eq("user_id", data.created_by)
    .eq("organization_id", data.organization_id)
    .is("revoked_at", null)
    .maybeSingle();
  if (membroErr) {
    throw new ApiTokenError("lookup_failed", `Token lookup failed: ${membroErr.message}`);
  }
  const papelDoCriador = (membro as { role?: string } | null)?.role as Role | undefined;
  // A dispensa do agente vale só até `ai_operator`: um token legado com
  // `actor:ai_agent` e `role:admin` (os escopos eram texto livre até a A4) não
  // escapa da comparação por se dizer agente.
  const papelDoToken = scopesRole(scopes);
  const dispensaDeAgente =
    scopes.includes("actor:ai_agent") && ROLE_RANK[papelDoToken] <= ROLE_RANK.ai_operator;
  const papelAlcanca =
    papelDoCriador !== undefined &&
    VALID_ROLES.has(papelDoCriador) &&
    (dispensaDeAgente || ROLE_RANK[papelDoCriador] >= ROLE_RANK[papelDoToken]);
  if (!papelAlcanca) {
    throw new ApiTokenError(
      "creator_inactive",
      "Token no longer valid: the member who created it left the organization or no longer has the role it grants. Ask an admin to issue a new token.",
    );
  }

  supabase
    .from("api_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id)
    .then(({ error: updErr }) => {
      if (updErr) {
        logger.warn("mcp.auth.last_used_at_update_failed", {
          api_token_id: data.id,
          error: updErr.message,
        });
      }
    });

  return {
    id: data.id,
    organizationId: data.organization_id,
    scopes,
    createdBy: data.created_by,
  };
}

/**
 * Mensagem do teto de falhas. Escrita para quem lê a resposta — quase sempre um
 * modelo: o texto é o único sinal útil depois do bloqueio. Nada de contador,
 * nada de "quantas faltam": a resposta não diz se o token existe nem quanto
 * resta da janela.
 */
const TETO_DE_TOKEN_MSG =
  "Too many failed token attempts. Wait a few minutes before retrying and send a valid `dsk_` API token — if yours was revoked or expired, issue a new one.";

export async function validateBearerToken(
  authHeader: string | null,
): Promise<McpAuthResult> {
  const plaintext = extractBearer(authHeader);
  if (!plaintext) {
    // Cabeçalho torto é o primeiro palpite de quem varre: conta antes de sair.
    await registrarFalhaDeToken(null);
    throw new McpAuthError(-32001, 401, "Missing or malformed Authorization header.");
  }

  // O teto vem ANTES de resolver o token: é esta linha que tira o custo zero da
  // tentativa — sem ela cada `dsk_` chutado custa um SELECT em `api_tokens` que
  // ninguém conta, e varrer tokens sai de graça (issue #1447).
  if (await tokenFailureLimited(plaintext)) {
    throw new McpAuthError(-32004, 429, TETO_DE_TOKEN_MSG);
  }

  let resolved: ResolvedApiToken;
  try {
    resolved = await resolveApiToken(plaintext);
  } catch (err) {
    if (err instanceof ApiTokenError) {
      if (err.reason !== "lookup_failed") {
        // Chute (malformado/desconhecido) debita o balde por ORIGEM; token real
        // e morto (revogado/expirado) debita só o do valor apresentado — ver
        // `registrarFalhaDeToken`. `lookup_failed` é falha NOSSA: não debita.
        await registrarFalhaDeToken(plaintext, {
          contaNoIp: err.reason === "malformed" || err.reason === "not_found",
        });
      }
      throw new McpAuthError(
        err.reason === "lookup_failed" ? -32603 : -32001,
        err.reason === "lookup_failed" ? 500 : 401,
        err.message,
      );
    }
    throw err;
  }

  const role = scopesRole(resolved.scopes);
  const actor = deriveActor(resolved.scopes, resolved.id);

  return {
    organizationId: resolved.organizationId,
    role,
    actor,
    apiTokenId: resolved.id,
    scopes: resolved.scopes,
  };
}

export function ensureRole(actual: Role, minimum: Role): void {
  if (ROLE_RANK[actual] < ROLE_RANK[minimum]) {
    throw new McpAuthError(
      -32002,
      403,
      `Role '${actual}' insufficient (required: '${minimum}').`,
    );
  }
}

export function ensureScope(scopes: string[], required: string): void {
  if (!scopes.includes(required)) {
    throw new McpAuthError(-32002, 403, `Token missing required scope '${required}'.`);
  }
}
