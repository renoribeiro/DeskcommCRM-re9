import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * AS TABELAS GRANDES TÊM ÍNDICE EM TODA CHAVE ESTRANGEIRA DE UMA COLUNA
 * (achados B5 e B6 de `docs/imobiliario/04-auditoria-seguranca-e-qualidade.md`,
 * migration 5000).
 *
 * Sem índice no lado que referencia, o `on delete` da linha referenciada varre
 * a tabela inteira: apagar uma etapa varria `crm_leads`, apagar um lead varria
 * `crm_lead_activities`, apagar um token varria `api_audit_log`. Um índice
 * composto que COMEÇA por `organization_id` não serve para isso — a checagem
 * da chave estrangeira não informa a organização (Postgres < 18 não faz
 * skip scan).
 *
 * A régua é medida no catálogo: para cada FK de UMA coluna nas tabelas que
 * crescem com o uso, existe um índice válido cuja PRIMEIRA coluna é a da FK.
 * Parcial vale (`where col is not null` é exatamente o que a FK consulta).
 */

/** As tabelas que crescem com cada mensagem, atividade ou requisição. */
const TABELAS_GRANDES = [
  "messages",
  "crm_lead_activities",
  "crm_leads",
  "conversations",
  "contacts",
  "api_audit_log",
] as const;

/**
 * FK sem índice aceita, com razão. Só encolhe.
 *
 * `organization_id` fica de fora da regra em todas: ele já lidera índices
 * compostos dessas tabelas, e apagar uma organização é operação rara que
 * varre tudo de qualquer jeito (cascata em dezenas de tabelas).
 */
const SEM_INDICE_PERMITIDO: ReadonlyMap<string, string> = new Map([
  [
    "crm_lead_activities.contact_id",
    "Preenchida em quase toda atividade: um índice só dela dobraria o custo de escrita da " +
      "maior tabela do CRM para servir a um evento raro — o contato não é apagado (a LGPD " +
      "anonimiza, a mescla repontua antes). A leitura usa idx_lead_activities_org_contact.",
  ],
  [
    "crm_lead_activities.actor_agent_id",
    "Preenchida em toda atividade do agente (a maioria numa operação com IA). Apagar um " +
      "agente é raro — `DELETE /api/v1/ai/agents/[id]` desativa ou arquiva, não apaga a " +
      "linha; a leitura usa " +
      "idx_lead_activities_org_actor_agent.",
  ],
]);

function fksSemIndice(): string[] {
  const lista = TABELAS_GRANDES.map((t) => `'${t}'`).join(",");
  const out = sql(`
    select c.conrelid::regclass::text || '.' || a.attname
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f'
       and c.connamespace = 'public'::regnamespace
       and array_length(c.conkey, 1) = 1
       and c.conrelid::regclass::text in (${lista})
       and a.attname <> 'organization_id'
       and not exists (
         select 1 from pg_index i
          where i.indrelid = c.conrelid
            and i.indisvalid
            and i.indkey[0] = c.conkey[1]
       )
     order by 1;
  `);
  return out === "" ? [] : out.split("\n");
}

describe("B5 — chave estrangeira das tabelas grandes tem índice (5000)", () => {
  it("CONTROLE: a sonda acha FKs indexadas (senão o vazio abaixo não prova nada)", () => {
    const n = sql(`
      select count(*) from pg_constraint c
       where c.contype = 'f' and c.conrelid = 'public.messages'::regclass
         and array_length(c.conkey, 1) = 1;
    `);
    expect(Number(n)).toBeGreaterThan(5);
  });

  it("⛔ toda FK de uma coluna das tabelas grandes tem índice começando por ela", () => {
    const faltando = fksSemIndice().filter((f) => !SEM_INDICE_PERMITIDO.has(f));
    expect(
      faltando,
      `FK sem índice no lado que referencia — o on delete da linha referenciada varre a tabela:\n  ${faltando.join("\n  ")}`,
    ).toEqual([]);
  });
});

describe("B6 — histórico que cresce tem índice iniciado por organization_id (5000)", () => {
  it.each([
    "conversation_notes",
    "conversation_assignment_events",
    "followup_enrollment_events",
    "agent_case_events",
  ])("`%s`", (tabela) => {
    const out = sql(`
      select count(*) from pg_index i
        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
       where i.indrelid = 'public.${tabela}'::regclass
         and i.indisvalid
         and a.attname = 'organization_id';
    `);
    expect(Number(out)).toBeGreaterThan(0);
  });
});
