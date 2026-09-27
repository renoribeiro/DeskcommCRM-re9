/**
 * O TOKEN EFÊMERO DO TURNO DO AGENTE NÃO DISPUTA O TETO DOS HUMANOS
 * (achado A5 de `docs/imobiliario/04-auditoria-seguranca-e-qualidade.md`,
 * parte de banco; migration 0439).
 *
 * Cada turno do agente grava em `api_tokens` um token `agent-run:<run_id>`
 * com validade de 5 minutos (`lib/ai/runtime/mcp_token.ts`, mintado pelo admin
 * client — sem JWT). Até a 0439 o gatilho `trg_teto_de_tokens_ativos` (0415)
 * contava esses tokens junto com os humanos: numa organização movimentada o
 * agente ocupava o teto de quem administra, e com o teto cheio o turno seguinte
 * do agente morria com PT409.
 *
 * Os casos:
 *   - com o teto de humanos CHEIO, o efêmero mintado sem JWT ainda entra;
 *   - com efêmeros vivos, o humano ainda emite até o teto (eles não contam);
 *   - quem está logado e imita o formato do efêmero continua barrado pelo teto
 *     na inserção — o atalho é do mintador, não do formato;
 *   - token de nome `agent-run:` com validade longa CONTA (não é efêmero).
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PORTA = process.env.TEST_DB_PORT ?? "54329";
const pool = new pg.Pool({
  connectionString: `postgres://postgres:postgres@127.0.0.1:${PORTA}/postgres`,
  max: 4,
});

const ORG = "a5a5a5a5-0000-4000-8000-00000000000a";
const USER = "a5a5a5a5-1111-4000-8000-00000000000a";

let teto = 0;

function erroDe(e: unknown): { code?: string; message: string } {
  const err = e as { code?: string; message?: string };
  return { code: err.code, message: err.message ?? String(e) };
}

async function inserir(
  nome: string,
  prefixo: string,
  validade: string | null,
): Promise<{ code?: string; message: string } | null> {
  try {
    await pool.query(
      `insert into public.api_tokens (organization_id, created_by, name, prefix, token_hash, scopes, expires_at)
       values ($1, $2, $3, $4, decode(md5(random()::text), 'hex'), '["mcp:read"]'::jsonb,
               case when $5::text is null then null else now() + $5::interval end)`,
      [ORG, USER, nome, prefixo, validade],
    );
    return null;
  } catch (e) {
    return erroDe(e);
  }
}

/** Efêmero como o mintador grava: nome `agent-run:`, prefixo `dsk_run_`, 5 min. */
const efemero = (i: string) => inserir(`agent-run:${i}`, `dsk_run_${i}`, "5 minutes");
const humano = (i: string) => inserir(`humano-${i}`, `dsk_h${i}`, null);

beforeAll(async () => {
  await pool.query(`delete from public.api_tokens where organization_id = $1`, [ORG]);
  await pool.query(`insert into auth.users (id, email) values ($1, 'a5@invariant.test') on conflict do nothing`, [USER]);
  await pool.query(
    `insert into public.organizations (id, slug, legal_name, display_name)
     values ($1, 'a5-inv', 'A5 Invariante', 'A5') on conflict do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into public.user_organizations (user_id, organization_id, role, accepted_at)
     values ($1, $2, 'admin', now()) on conflict do nothing`,
    [USER, ORG],
  );
  const { rows } = await pool.query<{ def: string }>(
    `select prosrc as def from pg_proc
      where proname = 'fn_teto_de_tokens_ativos' and pronamespace = 'public'::regnamespace`,
  );
  const batida = /v_teto\s+constant integer :=\s*(\d+)/.exec(rows[0]?.def ?? "");
  if (!batida) throw new Error("fn_teto_de_tokens_ativos não está instalada (ou perdeu v_teto)");
  teto = Number(batida[1]);
});

afterAll(async () => {
  await pool.end();
});

describe("A5 — o efêmero do agente fica fora do teto de tokens (0439)", () => {
  it("efêmeros vivos não ocupam vaga: o humano ainda emite até o teto", async () => {
    for (let i = 0; i < 5; i++) {
      expect(await efemero(`pre${i}`)).toBeNull();
    }
    for (let i = 0; i < teto; i++) {
      const erro = await humano(`${i}`);
      expect(erro, `emissão humana ${i + 1} de ${teto} recusada: ${erro?.message}`).toBeNull();
    }
    // CONTROLE: o teto dos humanos continua de pé.
    expect((await humano("estouro"))?.code).toBe("PT409");
  });

  it("⛔ com o teto dos humanos cheio, o turno do agente ainda consegue o seu token", async () => {
    const erro = await efemero("depois-do-teto");
    expect(erro, `efêmero recusado com o teto cheio: ${erro?.message}`).toBeNull();
  });

  it("quem está logado e imita o formato do efêmero continua barrado pelo teto", async () => {
    const cliente = await pool.connect();
    try {
      await cliente.query("begin");
      await cliente.query("set local role authenticated");
      await cliente.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: USER })]);
      let erro: { code?: string; message: string } | null = null;
      try {
        await cliente.query(
          `insert into public.api_tokens (organization_id, created_by, name, prefix, token_hash, scopes, expires_at)
           values ($1, $2, 'agent-run:imitado', 'dsk_run_imitado', decode(md5(random()::text), 'hex'), '[]'::jsonb,
                   now() + interval '5 minutes')`,
          [ORG, USER],
        );
      } catch (e) {
        erro = erroDe(e);
      }
      expect(erro?.code, `esperava PT409 e veio ${erro?.code}: ${erro?.message}`).toBe("PT409");
    } finally {
      await cliente.query("rollback").catch(() => undefined);
      cliente.release();
    }
  });

  it("nome `agent-run:` com validade longa não é efêmero: conta e é barrado", async () => {
    const erro = await inserir("agent-run:longo", "dsk_run_longo", "30 days");
    expect(erro?.code).toBe("PT409");
  });
});
