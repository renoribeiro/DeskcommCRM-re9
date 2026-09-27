/**
 * TOKEN GRAVADO POR PESSOA SÓ LEVA ESCOPO CONCEDÍVEL — NO BANCO, NÃO SÓ NA ROTA
 * (achado R7, a parte de banco do A4 de
 * `docs/imobiliario/04-auditoria-seguranca-e-qualidade.md`; migration 5001).
 *
 * A rota de emissão fecha a lista de escopos com Zod, mas a policy
 * `api_tokens_admin_only` deixa o administrador inserir DIRETO pela REST, com o
 * JWT da sessão. Até a 5001 isso gravava `actor:ai_agent` + `agent_run:<id>`
 * (passar-se pelo agente publicado) ou um nome `agent-run:` (que a listagem
 * esconde). O gatilho `trg_valida_token_de_pessoa` recusa com PT403 quando há
 * `auth.uid()`; o service role (mint efêmero, provisionamento) segue livre.
 *
 * Cada caso roda na sua própria transação com `set local role authenticated`
 * + `request.jwt.claims`, como o PostgREST faz, e termina em rollback.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PORTA = process.env.TEST_DB_PORT ?? "54329";
const pool = new pg.Pool({
  connectionString: `postgres://postgres:postgres@127.0.0.1:${PORTA}/postgres`,
  max: 4,
});

const ORG = "a4a4a4a4-0000-4000-8000-0000000000a4";
const ADMIN = "a4a4a4a4-1111-4000-8000-0000000000a4";
const GERENTE = "a4a4a4a4-2222-4000-8000-0000000000a4";

type Erro = { code?: string; message: string };

function erroDe(e: unknown): Erro {
  const err = e as { code?: string; message?: string };
  return { code: err.code, message: err.message ?? String(e) };
}

let seq = 0;

/**
 * Tenta gravar um token. `quem` = uuid do usuário (JWT de pessoa) ou
 * `"service_role"` (sem `sub`, como o admin client).
 */
async function inserir(
  quem: string,
  nome: string,
  scopes: unknown[],
  validade: string | null = null,
): Promise<Erro | null> {
  const cliente = await pool.connect();
  seq += 1;
  try {
    await cliente.query("begin");
    if (quem === "service_role") {
      await cliente.query("set local role service_role");
      await cliente.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ role: "service_role" }),
      ]);
    } else {
      await cliente.query("set local role authenticated");
      await cliente.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: quem, role: "authenticated" }),
      ]);
    }
    try {
      await cliente.query(
        `insert into public.api_tokens (organization_id, created_by, name, prefix, token_hash, scopes, expires_at)
         values ($1, $2, $3, $4, decode(md5(random()::text), 'hex'), $5::jsonb,
                 case when $6::text is null then null else now() + $6::interval end)`,
        [ORG, quem === "service_role" ? ADMIN : quem, nome, `dsk_a4${seq}`, JSON.stringify(scopes), validade],
      );
      return null;
    } catch (e) {
      return erroDe(e);
    }
  } finally {
    await cliente.query("rollback").catch(() => undefined);
    cliente.release();
  }
}

beforeAll(async () => {
  await pool.query(`delete from public.api_tokens where organization_id = $1`, [ORG]);
  for (const [id, email] of [
    [ADMIN, "a4-admin@invariant.test"],
    [GERENTE, "a4-gerente@invariant.test"],
  ] as const) {
    await pool.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [id, email]);
  }
  await pool.query(
    `insert into public.organizations (id, slug, legal_name, display_name)
     values ($1, 'a4-inv', 'A4 Invariante', 'A4') on conflict do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into public.user_organizations (user_id, organization_id, role, accepted_at)
     values ($1, $3, 'admin', now()), ($2, $3, 'manager', now()) on conflict do nothing`,
    [ADMIN, GERENTE, ORG],
  );
});

afterAll(async () => {
  await pool.query(`delete from public.api_tokens where organization_id = $1`, [ORG]);
  await pool.end();
});

describe("R7/A4 — token gravado por pessoa só leva escopo concedível (5001)", () => {
  it("CONTROLE: admin com escopo concedível grava normalmente", async () => {
    const erro = await inserir(ADMIN, "integracao-crm", ["mcp:read", "leads:write", "role:admin"]);
    expect(erro, `recusado: ${erro?.message}`).toBeNull();
  });

  it("⛔ admin pela REST com actor:ai_agent + agent_run: é recusado (PT403)", async () => {
    const erro = await inserir(ADMIN, "falso-agente", ["mcp:write", "actor:ai_agent", "agent_run:x"]);
    expect(erro?.code, `esperava PT403, veio ${erro?.code}: ${erro?.message}`).toBe("PT403");
  });

  it("⛔ só agent_run: também é recusado", async () => {
    expect((await inserir(ADMIN, "so-run", ["agent_run:abc"]))?.code).toBe("PT403");
  });

  it("⛔ escopo fora da lista fechada (role:ai_operator, integration:x) é recusado", async () => {
    expect((await inserir(ADMIN, "operador", ["role:ai_operator"]))?.code).toBe("PT403");
    expect((await inserir(ADMIN, "integracao", ["integration:nuvemshop"]))?.code).toBe("PT403");
  });

  it("⛔ escopo que não é texto é recusado", async () => {
    expect((await inserir(ADMIN, "numero", [42]))?.code).toBe("PT403");
  });

  it("⛔ nome agent-run: (qualquer caixa, com espaço à esquerda) é recusado", async () => {
    expect((await inserir(ADMIN, "agent-run:x", ["mcp:read"]))?.code).toBe("PT403");
    expect((await inserir(ADMIN, "  Agent-Run:y", ["mcp:read"]))?.code).toBe("PT403");
  });

  it("⛔ gerente com role:admin é recusado PELO GATILHO (PT403), antes da RLS", async () => {
    const erro = await inserir(GERENTE, "sobe-papel", ["role:admin"]);
    expect(erro?.code, `esperava PT403, veio ${erro?.code}: ${erro?.message}`).toBe("PT403");
  });

  it("CONTROLE: gerente com papel que cabe nele passa pelo gatilho e cai na RLS (42501)", async () => {
    // A policy é só de admin: o gerente não emite token de jeito nenhum. O que
    // este caso mede é QUEM recusa — a RLS, não o gatilho —, prova de que o
    // PT403 acima veio do teto de papel.
    const erro = await inserir(GERENTE, "papel-ok", ["role:viewer"]);
    expect(erro?.code, `esperava 42501, veio ${erro?.code}: ${erro?.message}`).toBe("42501");
  });

  it("service role grava o efêmero do agente (nome agent-run:, actor:/agent_run:)", async () => {
    const erro = await inserir(
      "service_role",
      "agent-run:run-1",
      ["mcp:read", "mcp:write", "actor:ai_agent", "agent_run:run-1", "role:ai_operator"],
      "5 minutes",
    );
    expect(erro, `efêmero recusado: ${erro?.message}`).toBeNull();
  });

  it("service role grava o token de provisionamento (integration:*)", async () => {
    expect(await inserir("service_role", "nuvemshop", ["integration:nuvemshop", "mcp:read"])).toBeNull();
  });

  it("UPDATE: admin não troca os escopos por um de servidor, mas revoga token de servidor", async () => {
    const cliente = await pool.connect();
    try {
      await cliente.query("begin");
      const { rows } = await cliente.query<{ id: string }>(
        `insert into public.api_tokens (organization_id, created_by, name, prefix, token_hash, scopes)
         values ($1, $2, 'provisionado', 'dsk_a4upd', decode(md5(random()::text), 'hex'),
                 '["integration:x"]'::jsonb) returning id`,
        [ORG, ADMIN],
      );
      const id = rows[0]!.id;
      await cliente.query("set local role authenticated");
      await cliente.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: ADMIN, role: "authenticated" }),
      ]);
      // Revogar (sem mexer em escopo nem nome) passa.
      await cliente.query(`update public.api_tokens set revoked_at = now() where id = $1`, [id]);
      await cliente.query("savepoint s");
      let erro: Erro | null = null;
      try {
        await cliente.query(`update public.api_tokens set scopes = '["actor:ai_agent"]'::jsonb where id = $1`, [id]);
      } catch (e) {
        erro = erroDe(e);
      }
      expect(erro?.code, `esperava PT403, veio ${erro?.code}: ${erro?.message}`).toBe("PT403");
    } finally {
      await cliente.query("rollback").catch(() => undefined);
      cliente.release();
    }
  });
});
