import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * NENHUMA TABELA DE `public` CONCEDE TRUNCATE A anon, authenticated OU PUBLIC
 * (achado B3 de `docs/imobiliario/04-auditoria-seguranca-e-qualidade.md`,
 * migration 5000).
 *
 * TRUNCATE ignora RLS — esvazia a tabela inteira, de todos os tenants. O
 * default ACL do Supabase (`GRANT ALL ON TABLES TO anon/authenticated`, que o
 * `pg_dump` reescreve no corpo do baseline a cada re-aplicação) concedia o
 * privilégio a toda tabela nova. Hoje a REST não expõe TRUNCATE, mas nenhum
 * caminho do produto precisa dele nesses papéis.
 *
 * Mede-se no banco que a suíte recebe, que é o baseline aplicado DUAS vezes
 * (install + update): é o estado de quem atualiza, em que o corpo do dump
 * devolve o default ACL antes de o apêndice tirá-lo.
 */

const PAPEIS = ["anon", "authenticated"] as const;

describe("B3 — TRUNCATE fora dos papéis do PostgREST (5000)", () => {
  it("CONTROLE: a sonda enxerga TRUNCATE quando ele existe", () => {
    // Sem isto, uma consulta com erro de digitação devolveria vazio e o caso
    // de baixo ficaria verde pelo motivo errado. `service_role` mantém o
    // privilégio (o dump concede ALL a ele), então a sonda tem de achá-lo.
    const n = sql(`
      select count(*) from pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
         and has_table_privilege('service_role', c.oid, 'TRUNCATE');
    `);
    expect(Number(n)).toBeGreaterThan(50);
  });

  it.each(PAPEIS)("⛔ `%s` não tem TRUNCATE em tabela nenhuma de public", (papel) => {
    const out = sql(`
      select c.relname from pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
         and has_table_privilege('${papel}', c.oid, 'TRUNCATE')
       order by 1;
    `);
    expect(out === "" ? [] : out.split("\n")).toEqual([]);
  });

  it("⛔ nenhum grant de TRUNCATE a PUBLIC em public", () => {
    const out = sql(`
      select count(*) from information_schema.role_table_grants
       where table_schema = 'public' and privilege_type = 'TRUNCATE' and grantee = 'PUBLIC';
    `);
    expect(out).toBe("0");
  });

  it("⛔ tabela criada DEPOIS também nasce sem TRUNCATE para anon/authenticated (default ACL)", () => {
    const out = sql(`
      create table public.b3_sonda_default_acl (id int);
      select has_table_privilege('anon', 'public.b3_sonda_default_acl', 'TRUNCATE')::int
          || ',' || has_table_privilege('authenticated', 'public.b3_sonda_default_acl', 'TRUNCATE')::int
          || ',' || has_table_privilege('authenticated', 'public.b3_sonda_default_acl', 'SELECT')::int;
      drop table public.b3_sonda_default_acl;
    `);
    // O SELECT continua (o default ACL do Supabase segue valendo para o resto);
    // só o TRUNCATE sai.
    expect(out.split("\n").filter((l) => /^\d,\d,\d$/.test(l))).toEqual(["0,0,1"]);
  });
});
