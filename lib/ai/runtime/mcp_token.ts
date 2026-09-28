/**
 * Ephemeral api_token mint for the agent runtime (S-13.08).
 *
 * Each run mints a short-lived (TTL 300s) `api_tokens` row scoped to MCP
 * read+write+ai_agent + a `agent_run:<runId>` marker. The runtime calls MCP
 * tools in-process (no HTTP loopback) but keeps the token row to satisfy
 * audit FK (`api_audit_log.actor_api_token_id`) and provide a real handle for
 * downstream tracing.
 *
 * `created_by` is required by the schema. Resolution order (active members
 * only — see `resolveCreatedBy`):
 *   1. version.created_by (passed by the caller)
 *   2. agent.created_by (passed by the caller)
 *   3. the highest-ranked active member of the org
 * If none, throws — runtime aborts with `error_code='no_actor_user'`.
 */
import { createHash, randomBytes } from "node:crypto";

import { ROLE_RANK, type Role } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";

export const EPHEMERAL_TOKEN_TTL_SEC = 300;

/**
 * O nome de todo token efêmero começa assim (`agent-run:<runId>`). É por ele
 * que a listagem de chaves os exclui e a poda diária os encontra; uma pessoa
 * não pode criar token com esse nome (`lib/schemas/team.ts`).
 */
export const PREFIXO_DO_TOKEN_EFEMERO = "agent-run:";

export interface MintEphemeralTokenInput {
  readOnly?: boolean;
  organizationId: string;
  runId: string;
  versionCreatedBy?: string | null;
  agentCreatedBy?: string | null;
  ttlSec?: number;
}

export interface EphemeralToken {
  id: string;
  plaintext: string;
  expiresAt: string;
}

/**
 * O prefixo do token efêmero — exportado porque a regra tem UM dono.
 *
 * ## O defeito que a entropia conserta
 *
 * Era `dsk_run_${runId.slice(0, 8)}`, derivado SÓ do run. `api_tokens` tem
 * `unique (organization_id, prefix)`, então o mesmo job retentado mintava com o
 * mesmo prefixo: a colisão não era rara, era **garantida em toda retentativa**.
 * Medido num turno real — o mint estourava, `buildMcpTurnTools` falhava, e o
 * turno seguia SEM capacidade nenhuma, deixando só um log de worker. Um blip de
 * rede degradava o agente para sem-mãos.
 *
 * Os 4 bytes aleatórios também matam o irmão silencioso: dois jobs distintos
 * cujos uuid coincidem nos 8 primeiros caracteres.
 *
 * ## Por que é seguro mexer no prefixo
 *
 * A autenticação bate `token_hash` (`lib/mcp/auth.ts`), nunca o prefixo — ele é
 * identificação para humano ler no audit, não chave de busca.
 *
 * ## Por que é exportado
 *
 * `tests/invariants/capacidades-ausentes.test.ts` exercita esta função contra a
 * constraint REAL do banco. Se o teste tivesse a própria cópia da regra, ele
 * continuaria verde depois de alguém reverter o conserto aqui — seria a segunda
 * lista, que é o defeito que ele existe para pegar.
 */
export function buildEphemeralPrefix(runId: string): string {
  return `dsk_run_${runId.slice(0, 8)}_${randomBytes(4).toString("hex")}`;
}

/**
 * Quem assina o token efêmero (`api_tokens.created_by`, `not null`).
 *
 * Só vale MEMBRO ATIVO da organização: `lib/mcp/auth.ts` recusa token cujo
 * criador saiu (`user_organizations.revoked_at`), então assinar com o autor de
 * uma versão que já deixou a empresa faria o turno inteiro ficar sem
 * ferramentas. Os candidatos (autor da versão, autor do agente) valem na
 * ordem, se ainda forem membros; senão, o membro ativo de papel MAIS ALTO.
 *
 * O desempate é pelo RANK do papel, nunca pelo texto: `order("role", desc)`
 * ordenava alfabeticamente (`viewer` > `manager` > `agent` > `admin`) e
 * escolhia justamente o papel mais baixo. Exportada para teste.
 */
export async function resolveCreatedBy(
  organizationId: string,
  ...candidates: Array<string | null | undefined>
): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("user_organizations")
    .select("user_id, role")
    .eq("organization_id", organizationId)
    .is("revoked_at", null);
  if (error) return null;
  const membros = ((data ?? []) as Array<{ user_id: string; role: string }>).filter(
    (m) => typeof m.user_id === "string",
  );
  const ativos = new Set(membros.map((m) => m.user_id));
  for (const c of candidates) {
    if (c && ativos.has(c)) return c;
  }
  const rank = (papel: string) => ROLE_RANK[papel as Role] ?? 0;
  const maisAlto = [...membros].sort((a, b) => rank(b.role) - rank(a.role))[0];
  return maisAlto?.user_id ?? null;
}

export async function mintEphemeralToken(input: MintEphemeralTokenInput): Promise<EphemeralToken> {
  const ttl = input.ttlSec ?? EPHEMERAL_TOKEN_TTL_SEC;
  const createdBy = await resolveCreatedBy(
    input.organizationId,
    input.versionCreatedBy,
    input.agentCreatedBy,
  );
  if (!createdBy) {
    throw new Error("no_actor_user_for_ephemeral_token");
  }

  const prefix = buildEphemeralPrefix(input.runId);
  const secret = randomBytes(32).toString("base64url");
  const plaintext = `${prefix}_${secret}`;
  const tokenHash = createHash("sha256").update(plaintext).digest();
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("api_tokens")
    .insert({
      organization_id: input.organizationId,
      created_by: createdBy,
      name: `${PREFIXO_DO_TOKEN_EFEMERO}${input.runId}`,
      prefix,
      token_hash: `\\x${tokenHash.toString("hex")}`,
      scopes: [
        "mcp:read",
        ...(input.readOnly ? [] : ["mcp:write"]),
        "actor:ai_agent",
        `agent_run:${input.runId}`,
        "role:ai_operator",
      ],
      expires_at: expiresAt,
    })
    .select("id, expires_at")
    .single();

  if (error || !data) {
    throw new Error(`ephemeral_token_insert_failed: ${error?.message ?? "unknown"}`);
  }

  return { id: data.id as string, plaintext, expiresAt: data.expires_at as string };
}

export async function revokeEphemeralToken(tokenId: string): Promise<void> {
  const admin = createAdminClient();
  await admin.from("api_tokens").update({ revoked_at: new Date().toISOString() }).eq("id", tokenId);
}
