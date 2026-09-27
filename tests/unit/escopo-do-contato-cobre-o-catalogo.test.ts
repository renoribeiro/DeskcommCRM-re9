/**
 * A1 — toda ferramenta do catálogo declara o seu escopo de contato.
 *
 * A fronteira "o agente só enxerga o cliente da conversa" mora na ponte
 * (`lib/ai/runtime/tools.ts`) e lê `ESCOPO_POR_FERRAMENTA`
 * (`lib/mcp/escopo-do-contato.ts`). Uma ferramenta nova que aceite
 * `contact_id`/`lead_id`/… e não declare o escopo seria a porta de volta do
 * vazamento — por isso este gate:
 *
 *  1. toda ferramenta de `allTools` tem entrada (e nenhuma entrada é órfã);
 *  2. todo campo escopável do schema está coberto pela declaração, a menos que
 *     a ferramenta seja `fora_do_atendimento` (recusada inteira no turno);
 *  3. ferramenta `livre` não tem campo escopável — "livre" com `contact_id` é
 *     contradição, não decisão;
 *  4. toda chave declarada existe no schema (declaração de campo que não
 *     existe é proteção que não protege nada).
 */
import { describe, expect, it } from "vitest";

import {
  CAMPOS_ESCOPAVEIS,
  ESCOPO_POR_FERRAMENTA,
  camposDeclarados,
} from "@/lib/mcp/escopo-do-contato";
import { allTools } from "@/lib/mcp/tools";

const camposDoSchema = (t: (typeof allTools)[number]) => Object.keys(t.inputSchema);

describe("escopo do contato — cobertura do catálogo", () => {
  it("GUARDA DE VACUIDADE: o catálogo tem ferramentas com campos escopáveis", () => {
    const comCampo = allTools.filter((t) =>
      camposDoSchema(t).some((c) => CAMPOS_ESCOPAVEIS.includes(c)),
    );
    expect(comCampo.length).toBeGreaterThan(20);
  });

  it("toda ferramenta do catálogo tem declaração, e nenhuma declaração é órfã", () => {
    const nomes = new Set(allTools.map((t) => t.name));
    const semDeclaracao = [...nomes].filter((n) => !(n in ESCOPO_POR_FERRAMENTA));
    expect(
      semDeclaracao,
      "Ferramenta sem entrada em ESCOPO_POR_FERRAMENTA (lib/mcp/escopo-do-contato.ts): " +
        "declare se ela é 'livre', 'do_contato' (com as chaves) ou 'fora_do_atendimento'.",
    ).toEqual([]);
    const orfas = Object.keys(ESCOPO_POR_FERRAMENTA).filter((n) => !nomes.has(n));
    expect(orfas, "declaração para ferramenta que não existe").toEqual([]);
  });

  it("todo campo escopável do schema está coberto pela declaração", () => {
    const faltas: string[] = [];
    for (const t of allTools) {
      const d = ESCOPO_POR_FERRAMENTA[t.name];
      if (!d || d.escopo === "fora_do_atendimento") continue;
      const cobertos = new Set(camposDeclarados(d));
      for (const campo of camposDoSchema(t)) {
        if (CAMPOS_ESCOPAVEIS.includes(campo) && !cobertos.has(campo)) {
          faltas.push(`${t.name}.${campo} (${d.escopo})`);
        }
      }
    }
    expect(
      faltas,
      "Campo que aponta para contato/negócio/compromisso/conversa/caso/retorno sem declaração: " +
        "o agente alcançaria o registro de OUTRO cliente por ele.",
    ).toEqual([]);
  });

  it("toda chave declarada existe no schema da ferramenta", () => {
    const fantasmas: string[] = [];
    for (const t of allTools) {
      const d = ESCOPO_POR_FERRAMENTA[t.name];
      if (!d) continue;
      const doSchema = new Set(camposDoSchema(t));
      for (const campo of camposDeclarados(d)) {
        if (!doSchema.has(campo)) fantasmas.push(`${t.name}.${campo}`);
      }
    }
    expect(fantasmas).toEqual([]);
  });

  it("ferramenta do contato sem nenhuma chave precisa recortar a resposta", () => {
    for (const [nome, d] of Object.entries(ESCOPO_POR_FERRAMENTA)) {
      if (d.escopo === "do_contato" && d.chaves.length === 0) {
        expect(d.recorte, `${nome} não tem chave nem recorte: não protege nada`).toBeDefined();
      }
    }
  });
});
