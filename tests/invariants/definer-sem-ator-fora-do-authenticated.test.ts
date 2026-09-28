import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * VARREDURA: definer que `authenticated` executa precisa saber QUEM chamou
 * (achado B2 de `docs/imobiliario/04-auditoria-seguranca-e-qualidade.md`,
 * migration 5000).
 *
 * ## O vão entre os dois gates que já existiam
 *
 *   - `hardening-definer-varredura.test.ts` proíbe `anon` em toda definer e
 *     vigia `authenticated` só nas VOLÁTEIS (as que escrevem). Definer
 *     `stable` fica de fora de propósito — os helpers de RLS precisam dela.
 *   - `definer-membership-varredura.test.ts` pega a definer que recebe a
 *     ORGANIZAÇÃO por argumento e não confere pertencimento.
 *
 * `fn_resolve_inbound_number(text)` passava pelos dois: é `stable`, e o
 * argumento é um número de telefone, não uma organização. Rodando como dono,
 * devolvia organização, modo de roteamento, agente e usuário de fallback de
 * QUALQUER número discado — a qualquer usuário logado de qualquer tenant.
 *
 * ## A régua
 *
 * Entra na varredura toda função de `public` que é `security definer`,
 * executável por `authenticated` (medido no catálogo, pelas duas origens de
 * EXECUTE) e chamável como RPC (gatilho não é — o Postgres recusa chamar
 * função `returns trigger` fora de gatilho). Ela tem de alcançar, no próprio
 * corpo ou pelo fecho transitivo de quem ela chama, uma pergunta sobre o ATOR:
 * `auth.uid()`, `auth.jwt()`, `auth.role()`, `fn_user_org_ids`,
 * `fn_is_platform_admin` ou o `request.jwt` cru. Quem não pergunta nada sobre
 * quem chamou responde igual para todo mundo — e, rodando como dono, por cima
 * da RLS.
 *
 * Conferir o ator não é conferir CERTO; esta varredura lê o corpo, não o
 * executa. A conferência de pertencimento continua com o gate vizinho, e o
 * caso executado de `fn_colegas_podem_mexer_na_agenda` fica aqui embaixo.
 */

interface Excecao {
  readonly fn: string;
  readonly razao: string;
}

/**
 * ⚠️ Só encolhe. Entrada nova exige razão escrita E o porquê de revogar de
 * `authenticated` (ou conferir o ator) não servir.
 */
const SEM_ATOR_PERMITIDO: readonly Excecao[] = [
  {
    fn: "comando_da_conversa(conversations)",
    razao:
      "Coluna computada do PostgREST (`conversations.comando_da_conversa`): recebe a LINHA " +
      "de `conversations` que o próprio chamador já leu sob RLS e só lê `force_human`/" +
      "`is_blocked` do contato daquela linha, na organização daquela linha. Revogar de " +
      "`authenticated` quebra a leitura da inbox. Resíduo declarado: um literal de linha " +
      "montado à mão com ids conhecidos de outro tenant revela esses dois booleanos.",
  },
];

interface Fn {
  readonly assinatura: string;
  readonly confereAtor: boolean;
}

function varrer(): Fn[] {
  const out = sql(`
    with todas as (
      select p.oid,
             p.proname,
             coalesce(p.prosrc, '') as src,
             p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as assinatura,
             (p.prosecdef
              and has_function_privilege('authenticated', p.oid, 'EXECUTE')
              and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
             ) as alvo
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
    )
    select f.assinatura,
           f.proname,
           (f.src ~* '(auth[.](uid|jwt|role)[(][)]|fn_user_org_ids|fn_is_platform_admin|request[.]jwt)')::int,
           f.alvo::int,
           coalesce(string_agg(distinct g.proname, ','), '')
      from todas f
      left join todas g
        on g.oid <> f.oid
       and f.src ~ ('(^|[^a-z0-9_])' || g.proname || '([^a-z0-9_]|$)')
     group by f.assinatura, f.proname, f.src, f.alvo
     order by 1;
  `);

  const brutas = out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const c = l.split("|");
      return {
        assinatura: c[0] ?? "",
        proname: c[1] ?? "",
        direto: c[2] === "1",
        alvo: c[3] === "1",
        chama: (c[4] ?? "").split(",").filter(Boolean),
      };
    });

  // Fecho transitivo por NOME, o mesmo desenho de definer-membership-varredura.
  const conferem = new Set(brutas.filter((b) => b.direto).map((b) => b.proname));
  for (;;) {
    const antes = conferem.size;
    for (const b of brutas) {
      if (conferem.has(b.proname)) continue;
      if (b.chama.some((n) => conferem.has(n))) conferem.add(b.proname);
    }
    if (conferem.size === antes) break;
  }

  return brutas
    .filter((b) => b.alvo)
    .map((b) => ({ assinatura: b.assinatura, confereAtor: conferem.has(b.proname) }));
}

const FUNCOES = varrer();
const PERMITIDAS = new Set(SEM_ATOR_PERMITIDO.map((e) => e.fn));

const ORG_A = "b2b2b2b2-0000-4000-8000-00000000000a";
const ORG_B = "b2b2b2b2-0000-4000-8000-00000000000b";
const USER_A = "b2b2b2b2-1111-4000-8000-00000000000a";

describe("B2 — definer executável por authenticated pergunta quem chamou (5000)", () => {
  it("CONTROLE: a varredura acha funções e reconhece a conferência por delegação", () => {
    expect(FUNCOES.length).toBeGreaterThan(10);
    const conferem = FUNCOES.filter((f) => f.confereAtor).map((f) => f.assinatura.split("(")[0]);
    // `fn_role_at_least` não cita auth.uid(): pergunta a fn_user_role_in_org.
    expect(conferem).toContain("fn_role_at_least");
    expect(conferem).toContain("fn_user_org_ids");
  });

  it("⛔ nenhuma definer executável por authenticated deixa de perguntar pelo ator", () => {
    const faltando = FUNCOES.filter((f) => !f.confereAtor && !PERMITIDAS.has(f.assinatura)).map(
      (f) => f.assinatura,
    );
    expect(
      faltando,
      `Função SECURITY DEFINER de public executável por 'authenticated' que não pergunta\n` +
        `nada sobre QUEM chamou (auth.uid / fn_user_org_ids / papel). Ela responde igual\n` +
        `para qualquer usuário logado de qualquer tenant, por cima da RLS.\n\n` +
        `Conserto: se só o servidor chama, revogue de authenticated e conceda a\n` +
        `service_role; se a tela chama, confira o ator no corpo. Exceção só em\n` +
        `SEM_ATOR_PERMITIDO, com a razão escrita:\n  ` +
        faltando.join("\n  "),
    ).toEqual([]);
  });

  it("a allowlist não guarda função que já não existe ou já confere", () => {
    const vivas = new Set(FUNCOES.filter((f) => !f.confereAtor).map((f) => f.assinatura));
    const mortas = SEM_ATOR_PERMITIDO.filter((e) => !vivas.has(e.fn)).map((e) => e.fn);
    expect(mortas).toEqual([]);
  });

  it("fn_resolve_inbound_number: só service_role executa, com search_path fixo", () => {
    const out = sql(`
      select has_function_privilege('anon', 'public.fn_resolve_inbound_number(text)', 'EXECUTE')::int,
             has_function_privilege('authenticated', 'public.fn_resolve_inbound_number(text)', 'EXECUTE')::int,
             has_function_privilege('service_role', 'public.fn_resolve_inbound_number(text)', 'EXECUTE')::int,
             coalesce(array_to_string(p.proconfig, ','), '')
        from pg_proc p
       where p.oid = 'public.fn_resolve_inbound_number(text)'::regprocedure;
    `);
    const [anon, auth, service, config] = out.split("|");
    expect(anon).toBe("0");
    expect(auth).toBe("0");
    expect(service).toBe("1");
    expect(config).toMatch(/search_path=/);
  });

  it("fn_colegas_podem_mexer_na_agenda responde a própria organização e cala sobre a alheia", () => {
    sql(`
      insert into auth.users (id, email) values ('${USER_A}', 'b2-a@invariant.test') on conflict (id) do nothing;
      insert into public.organizations (id, slug, legal_name, display_name, settings) values
        ('${ORG_A}', 'b2-inv-a', 'B2 A', 'B2 A', '{}'::jsonb),
        ('${ORG_B}', 'b2-inv-b', 'B2 B', 'B2 B', '{"colegas_podem_mexer_na_agenda": false}'::jsonb)
        on conflict (id) do nothing;
      insert into public.user_organizations (user_id, organization_id, role, accepted_at)
        values ('${USER_A}', '${ORG_A}', 'agent', now()) on conflict do nothing;
    `);
    const como = (org: string): string =>
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${USER_A}"}', false);
        select coalesce(public.fn_colegas_podem_mexer_na_agenda('${org}')::text, 'null');
      `)
        .split("\n")
        .pop() ?? "";
    expect(como(ORG_A)).toBe("true");
    // A organização B desligou a opção; quem é de A não pode descobrir isso.
    expect(como(ORG_B)).toBe("null");
    // Sem JWT (service role, núcleo interno) a resposta é a verdadeira.
    expect(sql(`select public.fn_colegas_podem_mexer_na_agenda('${ORG_B}')::text;`)).toBe("false");
  });
});
