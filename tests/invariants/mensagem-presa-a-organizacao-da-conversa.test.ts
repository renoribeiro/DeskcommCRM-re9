import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * A MENSAGEM É DA MESMA ORGANIZAÇÃO QUE A CONVERSA — nas duas pontas da RLS
 * (achado B1 de `docs/imobiliario/04-auditoria-seguranca-e-qualidade.md`,
 * migration 5000).
 *
 * ## O ataque
 *
 * Até a 5000, `messages_insert` perguntava só "a LINHA é da sua organização?"
 * e `messages_select` só "você enxerga a CONVERSA apontada?". Um atendente da
 * organização A gravava pela REST (anon key + o próprio JWT) uma mensagem com
 * `organization_id = A` e o `conversation_id` de uma conversa de B: o INSERT
 * passava, e a linha aparecia na conversa de B para todo mundo de B —
 * mensagem forjada dentro do atendimento do vizinho.
 *
 * ## Como se mede
 *
 * Sob o papel `authenticated` com o JWT de cada usuário, que é o caminho do
 * PostgREST. O INSERT do ataque roda SEM `returning`, de propósito: com
 * `returning` a policy de SELECT também é avaliada na linha nova e o ataque
 * seria barrado por ela — o teste ficaria verde antes do conserto, pelo motivo
 * errado. O desfecho é medido como `postgres` (sem RLS), no estado do banco.
 */

const ORG_A = "b1b1b1b1-0000-4000-8000-00000000000a";
const ORG_B = "b1b1b1b1-0000-4000-8000-00000000000b";
const USER_A = "b1b1b1b1-1111-4000-8000-00000000000a";
const USER_B = "b1b1b1b1-1111-4000-8000-00000000000b";
const SESS_A = "b1b1b1b1-2222-4000-8000-00000000000a";
const SESS_B = "b1b1b1b1-2222-4000-8000-00000000000b";
const CONTACT_A = "b1b1b1b1-3333-4000-8000-00000000000a";
const CONTACT_B = "b1b1b1b1-3333-4000-8000-00000000000b";
const CONV_A = "b1b1b1b1-4444-4000-8000-00000000000a";
const CONV_B = "b1b1b1b1-4444-4000-8000-00000000000b";
/** Linha já inconsistente (org A, conversa de B), gravada por fora da RLS —
 *  o resíduo que um banco atacado antes do conserto pode ter. */
const MSG_FORJADA = "b1b1b1b1-5555-4000-8000-000000000001";
/** Mensagem legítima de A, na conversa de A. */
const MSG_A = "b1b1b1b1-5555-4000-8000-000000000002";

function comoUsuario(userId: string, corpo: string): string {
  return sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${corpo}
  `);
}

/** Roda a escrita como o usuário; devolve true se o banco aceitou. */
function aceitou(userId: string, dml: string): boolean {
  try {
    comoUsuario(userId, `${dml};`);
    return true;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    if (stderr.includes("row-level security")) return false;
    throw err;
  }
}

function contar(query: string): number {
  const out = sql(query);
  const ultima = out.split("\n").pop() ?? "";
  if (!/^\d+$/.test(ultima)) throw new Error(`saída inesperada do psql: ${out}`);
  return Number(ultima);
}

function contarComo(userId: string, query: string): number {
  const out = comoUsuario(userId, query);
  const ultima = out.split("\n").pop() ?? "";
  if (!/^\d+$/.test(ultima)) throw new Error(`saída inesperada do psql: ${out}`);
  return Number(ultima);
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${USER_A}', 'b1-a@invariant.test'), ('${USER_B}', 'b1-b@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'b1-inv-a', 'B1 Invariante A', 'B1 A'),
      ('${ORG_B}', 'b1-inv-b', 'B1 Invariante B', 'B1 B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${USER_A}', '${ORG_A}', 'agent', now()),
      ('${USER_B}', '${ORG_B}', 'admin', now())
      on conflict do nothing;
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted) values
      ('${SESS_A}', '${ORG_A}', 'b1-inv-a', '\\x00'::bytea),
      ('${SESS_B}', '${ORG_B}', 'b1-inv-b', '\\x00'::bytea)
      on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, display_name) values
      ('${CONTACT_A}', '${ORG_A}', 'Contato B1 A'),
      ('${CONTACT_B}', '${ORG_B}', 'Contato B1 B')
      on conflict (id) do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id) values
      ('${CONV_A}', '${ORG_A}', '${CONTACT_A}', '${SESS_A}'),
      ('${CONV_B}', '${ORG_B}', '${CONTACT_B}', '${SESS_B}')
      on conflict (id) do nothing;
    insert into public.messages (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, body) values
      ('${MSG_FORJADA}', '${ORG_A}', '${CONV_B}', '${SESS_A}', '${CONTACT_A}', 'text', 'outbound', 'forjada antes do conserto'),
      ('${MSG_A}', '${ORG_A}', '${CONV_A}', '${SESS_A}', '${CONTACT_A}', 'text', 'outbound', 'legítima')
      on conflict (id) do nothing;
  `);
});

describe("B1 — a mensagem é da mesma organização que a conversa (5000)", () => {
  it("CONTROLE: o atendente de A grava mensagem na conversa de A", () => {
    // Sem este caso, uma policy que recusasse TUDO deixaria o ataque abaixo
    // verde — e quebraria o envio pela tela.
    expect(
      aceitou(
        USER_A,
        `insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, body)
         values ('${ORG_A}', '${CONV_A}', '${SESS_A}', '${CONTACT_A}', 'text', 'outbound', 'controle b1')`,
      ),
    ).toBe(true);
    expect(contar(`select count(*) from public.messages where conversation_id = '${CONV_A}' and body = 'controle b1';`)).toBe(1);
  });

  it("⛔ o atendente de A NÃO grava mensagem na conversa de B", () => {
    const antes = contar(`select count(*) from public.messages where conversation_id = '${CONV_B}';`);
    const ok = aceitou(
      USER_A,
      `insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, body)
       values ('${ORG_A}', '${CONV_B}', '${SESS_A}', '${CONTACT_A}', 'text', 'outbound', 'injetada b1')`,
    );
    expect(ok, "INSERT com conversation_id de outra organização foi aceito").toBe(false);
    expect(contar(`select count(*) from public.messages where conversation_id = '${CONV_B}';`)).toBe(antes);
  });

  it("⛔ quem é de B não enxerga mensagem de outra organização pendurada na conversa de B", () => {
    // A linha forjada existe (seed como postgres) — é o que prova que o zero
    // abaixo vem da policy e não da ausência do dado.
    expect(contar(`select count(*) from public.messages where id = '${MSG_FORJADA}';`)).toBe(1);
    expect(contarComo(USER_B, `select count(*) from public.messages where id = '${MSG_FORJADA}';`)).toBe(0);
  });

  it("⛔ quem é de A também não a enxerga (a conversa não é de A)", () => {
    expect(contarComo(USER_A, `select count(*) from public.messages where id = '${MSG_FORJADA}';`)).toBe(0);
  });

  it("CONTROLE: cada um enxerga a mensagem legítima da própria conversa", () => {
    expect(contarComo(USER_A, `select count(*) from public.messages where id = '${MSG_A}';`)).toBe(1);
    expect(contarComo(USER_B, `select count(*) from public.messages where id = '${MSG_A}';`)).toBe(0);
  });

  it("⛔ UPDATE não muda a mensagem de A para a conversa de B", () => {
    const ok = aceitou(
      USER_A,
      `update public.messages set conversation_id = '${CONV_B}' where id = '${MSG_A}'`,
    );
    expect(ok, "UPDATE moveu a mensagem para a conversa de outra organização").toBe(false);
    expect(contar(`select count(*) from public.messages where id = '${MSG_A}' and conversation_id = '${CONV_A}';`)).toBe(1);
  });

  it("CONTROLE: UPDATE comum na própria mensagem continua passando", () => {
    expect(aceitou(USER_A, `update public.messages set body = 'editada b1' where id = '${MSG_A}'`)).toBe(true);
    expect(contar(`select count(*) from public.messages where id = '${MSG_A}' and body = 'editada b1';`)).toBe(1);
  });

  it("a cláusula do administrador da plataforma continua nas três policies", () => {
    const out = sql(`
      select polname
        from pg_policy
       where polrelid = 'public.messages'::regclass
         and polname in ('messages_select', 'messages_insert', 'messages_update')
         and coalesce(pg_get_expr(polqual, polrelid), '') || coalesce(pg_get_expr(polwithcheck, polrelid), '')
             like '%fn_is_platform_admin()%'
       order by 1;
    `);
    expect(out.split("\n")).toEqual(["messages_insert", "messages_select", "messages_update"]);
  });
});
