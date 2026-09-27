/**
 * EPIC-09 Team & Permissions — Zod schemas for invite, accept, role change, and api token.
 *
 * Roles are stored as `text` with a check constraint (not enum) on
 * `user_organizations.role` per project doctrine — keep this list in sync
 * with the DB constraint when adding/removing roles.
 */
import { z } from "zod";
import { interfaceSettingsSchema, interfaceTemDestino } from "@/lib/navigation/interface";

export const ROLES = ["viewer", "agent", "manager", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const inviteMemberSchema = z.object({
  invitations: z
    .array(
      z
        .object({
          email: z.string().email(),
          role: z.enum(ROLES),
          interface_settings: interfaceSettingsSchema.optional(),
        })
        .refine((v) => !v.interface_settings || interfaceTemDestino(v.interface_settings, v.role), {
          message: "Selecione ao menos uma área permitida ao papel.",
          path: ["interface_settings"],
        }),
    )
    .min(1)
    .max(20),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const acceptInviteSchema = z.object({
  token: z.string().min(20),
});
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;

export const changeRoleSchema = z.object({
  role: z.enum(ROLES),
});
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;

/**
 * Os escopos que uma PESSOA pode conceder a um token pela tela ou pela API.
 *
 * Lista FECHADA. Antes era `z.string()`: dava para gravar `actor:ai_agent` e
 * `agent_run:<id>` num token humano e se passar pelo agente publicado (audit,
 * FK de atividade, gate de canal), ou `role:ai_operator`, papel que nenhuma
 * pessoa tem. Esses três prefixos são do servidor — o mint efêmero
 * (`lib/ai/runtime/mcp_token.ts`) e o provisionamento (`integration:*`,
 * `lib/tenants/api-key.ts`) gravam direto, sem passar por aqui.
 *
 * O `role:` concedido também não pode passar o papel de quem cria — isso é
 * conferido na rota, que conhece o papel (`papelDoTokenCabeNoCriador`).
 */
export const ESCOPOS_DE_TOKEN_CONCEDIVEIS = [
  "mcp:read",
  "mcp:write",
  "role:viewer",
  "role:agent",
  "role:manager",
  "role:admin",
  "contacts:read",
  "contacts:write",
  "leads:read",
  "leads:write",
  "messages:read",
  "messages:write",
  "messages:on_behalf",
  "audit:read",
] as const;
export type EscopoDeToken = (typeof ESCOPOS_DE_TOKEN_CONCEDIVEIS)[number];

const RANK_HUMANO: Record<Role, number> = { viewer: 1, agent: 2, manager: 4, admin: 5 };

/** O `role:` do token (o primeiro, como `lib/mcp/auth.ts` lê), ou `agent` por padrão. */
export function papelDoToken(scopes: readonly string[]): Role {
  for (const s of scopes) {
    if (s.startsWith("role:")) {
      const r = s.slice("role:".length);
      if ((ROLES as readonly string[]).includes(r)) return r as Role;
    }
  }
  return "agent";
}

/** O token não concede papel acima do de quem o cria. */
export function papelDoTokenCabeNoCriador(
  scopes: readonly string[],
  papelDoCriador: string | null | undefined,
): boolean {
  const criador = RANK_HUMANO[papelDoCriador as Role] ?? 0;
  return RANK_HUMANO[papelDoToken(scopes)] <= criador;
}

export const createApiTokenSchema = z.object({
  // `agent-run:` é o nome reservado do token efêmero do agente
  // (`lib/ai/runtime/mcp_token.ts`): a listagem esconde esse prefixo, então
  // uma chave humana com ele ficaria invisível para os outros admins.
  name: z
    .string()
    .min(2)
    .max(100)
    .refine((n) => !n.trim().toLowerCase().startsWith("agent-run:"), {
      message: "Este nome é reservado para uso interno. Escolha outro.",
    }),
  scopes: z
    .array(z.enum(ESCOPOS_DE_TOKEN_CONCEDIVEIS))
    .min(1)
    .refine((lista) => lista.filter((s) => s.startsWith("role:")).length <= 1, {
      message: "Escolha no máximo um papel (role:) para o token.",
    }),
  expires_in_days: z.coerce.number().int().min(1).max(365).optional(),
});
export type CreateApiTokenInput = z.infer<typeof createApiTokenSchema>;
