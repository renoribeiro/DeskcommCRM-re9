/**
 * A LISTA DE ESCOPOS CONCEDÍVEIS É UMA SÓ — NO ZOD E NO GATILHO DO BANCO.
 *
 * `ESCOPOS_DE_TOKEN_CONCEDIVEIS` (`lib/schemas/team.ts`) fecha o que a ROTA
 * aceita; `fn_token_de_pessoa_so_com_escopo_concedivel` (migration 5001, fork
 * imob, achado R7) fecha o que o BANCO aceita de quem tem JWT — porque a policy
 * `api_tokens_admin_only` deixa o administrador inserir direto pela REST, sem
 * passar pela rota. As duas listas são escritas à mão em linguagens diferentes;
 * se divergirem, ou a tela oferece escopo que o banco recusa (403 na emissão),
 * ou o banco aceita pela REST o que a rota recusa (a porta que o R7 fechou).
 *
 * Mede-se a ÚLTIMA definição da função nas duas fontes que instalam o banco:
 * a cadeia de migrations (em ordem) e o `baseline.sql` (a última vence — ver
 * item 10 da doutrina de migrations no CLAUDE.md).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ESCOPOS_DE_TOKEN_CONCEDIVEIS } from "@/lib/schemas/team";

const RAIZ = join(process.cwd(), "supabase");
const FUNCAO = "create or replace function public.fn_token_de_pessoa_so_com_escopo_concedivel";

/** A lista do `array[...]` de `v_escopos_concediveis` na ÚLTIMA definição do texto. */
function listaDoSql(texto: string): string[] | null {
  const i = texto.lastIndexOf(FUNCAO);
  if (i === -1) return null;
  const fim = texto.indexOf("$$;", i);
  const corpo = texto.slice(i, fim === -1 ? undefined : fim);
  const m = /v_escopos_concediveis\s+constant\s+text\[\]\s*:=\s*array\[([\s\S]*?)\]/.exec(corpo);
  if (!m) return null;
  return [...m[1]!.matchAll(/'([^']*)'/g)].map((x) => x[1]!);
}

function ultimaNaCadeia(): { arquivo: string; lista: string[] } | null {
  let achada: { arquivo: string; lista: string[] } | null = null;
  for (const arquivo of readdirSync(join(RAIZ, "migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const lista = listaDoSql(readFileSync(join(RAIZ, "migrations", arquivo), "utf8"));
    if (lista) achada = { arquivo, lista };
  }
  return achada;
}

const ts = [...ESCOPOS_DE_TOKEN_CONCEDIVEIS];

describe("escopos concedíveis: banco × TypeScript", () => {
  it("a última definição no baseline tem EXATAMENTE a lista do Zod, na mesma ordem", () => {
    const lista = listaDoSql(readFileSync(join(RAIZ, "baseline.sql"), "utf8"));
    expect(lista, "função ou v_escopos_concediveis ausente do baseline.sql").not.toBeNull();
    expect(lista).toEqual(ts);
  });

  it("a última definição na cadeia de migrations também", () => {
    const achada = ultimaNaCadeia();
    expect(achada, "nenhuma migration define a função").not.toBeNull();
    expect(achada!.lista, `divergência em ${achada!.arquivo}`).toEqual(ts);
  });

  it("a sonda enxerga divergência (sabotagem: um escopo a mais no SQL)", () => {
    const sql = readFileSync(join(RAIZ, "baseline.sql"), "utf8");
    const sabotado = `${sql}\n${FUNCAO}() returns trigger language plpgsql as $$\ndeclare\n  v_escopos_concediveis constant text[] := array[\n${ts
      .map((e) => `'${e}'`)
      .join(",\n")},\n'actor:ai_agent'\n  ];\nbegin return new; end;\n$$;\n`;
    expect(listaDoSql(sabotado)).not.toEqual(ts);
    expect(listaDoSql(sabotado)).toContain("actor:ai_agent");
  });
});
