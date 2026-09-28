/**
 * A RECUSA DA SPEC EM SEGUNDOS, NÃO EM 20 MINUTOS (issue #1692).
 *
 * ## O defeito que este teste encurta
 *
 * O caso de recusa de `tests/e2e/capacidades-do-agente.spec.ts` clica em
 * "Atender" e espera `/faltam? 1 vaga/`. A aritmética é o seed da spec (hoje 10,
 * todas FORA do pacote) somado às 16 do pacote: 26 contra o teto de 25. Quando
 * uma ferramenta nova entra em `atender` — a #1684 fez exatamente isso — a
 * recusa na tela vira "faltam 2 vagas" e quem repara é o e2e, uns 20 minutos
 * depois, longe da mudança que causou o problema.
 *
 * ## O que se guarda
 *
 * A CONTA, não os números soltos: seed da spec + pacote "atender" tem de
 * exceder o teto em EXATAMENTE uma vaga. Estourar por 2 já é outro texto na
 * tela e o caso da spec morre; caber no teto é a recusa sumir e o caso virar
 * um clique que sempre dá verde — os dois desfechos errados são comentados na
 * própria spec, com história. Ler o catálogo e o seed da spec deixa o aviso
 * acontecer no mesmo `pnpm test:unit` de sempre.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TOOL_CATALOG } from "@/lib/mcp/tools/catalogo";
import { IDS_DO_HARNESS } from "@/lib/mcp/tools/ferramentas-do-harness";
import {
  TETO_TOOLS_POR_AGENTE,
  vagasExigidasPeloPacote,
} from "@/lib/mcp/tools/selecao-por-pacote";

const SPEC_DA_E2E = join(process.cwd(), "tests/e2e/capacidades-do-agente.spec.ts");
const SCRIPT_DO_SEED = join(process.cwd(), "scripts/seed-e2e-capacidades.ts");

/** As entradas `"crm_...",` de um array literal, ignorando os comentários. */
function entradasDoBloco(bloco: string): string[] {
  return [...bloco.matchAll(/^\s*"([^"]+)",?\s*$/gm)].map((m) => m[1]!);
}

/**
 * O que o SCRIPT de seed de fato grava no agente (`TOOLS_LIGADAS`). A spec
 * DESCREVE o cenário; é o script que o monta no banco. As duas listas andavam
 * separadas: a auditoria A1 acrescentou a décima ferramenta à spec e não ao
 * script — o banco recebia 9, o pacote cabia (9 + 16 = 25), a recusa sumia na
 * tela e três casos da e2e caíam em cascata, com esta conta aqui verde.
 */
function toolsGravadasPeloScriptDoSeed(): string[] {
  const texto = readFileSync(SCRIPT_DO_SEED, "utf8");
  const bloco = texto.match(/const TOOLS_LIGADAS = \[([\s\S]*?)\];/);
  if (!bloco?.[1]) {
    throw new Error(
      "const TOOLS_LIGADAS não existe mais em scripts/seed-e2e-capacidades.ts. " +
        "Este teste compara o que o script grava com o que a spec supõe — atualize os dois juntos.",
    );
  }
  return entradasDoBloco(bloco[1]);
}

/**
 * O seed lido do ARQUIVO, não importado: a spec roda `loadCreds()` no corpo do
 * módulo (spawna scripts de seed) e importá-la aqui levaria o e2e inteiro para
 * dentro do unitário. O contrato é o `const TOOLS_DO_SEED = [...]` — se
 * renomearem a constante, este teste reprova e a pessoa atualiza os dois juntos.
 */
function toolsDoSeedDaSpec(): string[] {
  const texto = readFileSync(SPEC_DA_E2E, "utf8");
  const bloco = texto.match(/const TOOLS_DO_SEED = \[([\s\S]*?)\];/);
  if (!bloco?.[1]) {
    throw new Error(
      "const TOOLS_DO_SEED não existe mais em tests/e2e/capacidades-do-agente.spec.ts. " +
        "Este teste lê o seed de lá de propósito — atualize os dois juntos.",
    );
  }
  // Só as entradas `"crm_...",` em linha própria; os comentários dentro do
  // bloco começam com `//` e não casam.
  return entradasDoBloco(bloco[1]);
}

/**
 * O catálogo COMO A TELA O VÊ, não o dado cru.
 *
 * A rota `/api/v1/mcp/tools` serve `marcavel: false` para o que é do harness
 * (`catalogo-servido.ts`), e é a lista servida que o `ToolPicker` soma: o
 * `crm_send_whatsapp_message` é crítica de "atender" no arquivo do catálogo,
 * mas o motor a descarta e a tela não a oferece — contar o dado cru daria 27 e
 * acusaria uma recusa que a tela não mostra. As outras duas metades da junção
 * já têm dono: entrada × handler em `catalogo-servido.test.ts`, e a lista de
 * harness em `capacidade-do-harness-nao-e-oferecida.test.ts`.
 */
const CATALOGO_DA_TELA = TOOL_CATALOG.map((entrada) => ({
  ...entrada,
  marcavel: !IDS_DO_HARNESS.has(entrada.name),
}));

const SEED = toolsDoSeedDaSpec();
const EM_ATENDER = CATALOGO_DA_TELA.filter((c) => c.pacotes.includes("atender")).map(
  (c) => c.name,
);

describe("ligar Atender com o seed da spec excede o teto em exatamente uma vaga", () => {
  it("leu o seed da spec (guarda de vacuidade)", () => {
    // Um seed vazio faria a conta abaixo medir só o pacote — verde sobre nada.
    expect(SEED.length, "o seed da spec foi lido vazio").toBeGreaterThan(0);
    expect(EM_ATENDER.length, "o pacote 'atender' sumiu do catálogo").toBeGreaterThan(0);
  });

  it("o script de seed grava EXATAMENTE a lista que a spec supõe, na mesma ordem", () => {
    // A ordem conta: o caso do teto desliga `TOOLS_DO_SEED[2]` para liberar uma vaga.
    expect(
      toolsGravadasPeloScriptDoSeed(),
      "scripts/seed-e2e-capacidades.ts (TOOLS_LIGADAS) e a spec (TOOLS_DO_SEED) divergiram: " +
        "a conta abaixo mede a spec, mas quem monta o banco da e2e é o script",
    ).toEqual(SEED);
  });

  it("cada ferramenta do seed existe no catálogo", () => {
    const nomes = new Set(CATALOGO_DA_TELA.map((c) => c.name));
    for (const ferramenta of SEED) {
      expect(
        nomes.has(ferramenta),
        `o seed cita "${ferramenta}", que o catálogo não tem — spec e catálogo andaram separados`,
      ).toBe(true);
    }
  });

  it("nenhuma ferramenta do seed está DENTRO de Atender", () => {
    // Se uma entrasse, a união seria menor que a soma e a aritmética da spec
    // (seed + pacote) deixaria de descrever o que a tela faz ao clicar.
    for (const ferramenta of SEED) {
      expect(
        EM_ATENDER.includes(ferramenta),
        `o seed tem "${ferramenta}" DENTRO de "atender": a soma seed+pacote não é mais a união`,
      ).toBe(false);
    }
  });

  it("o excedente é 1 — o número que a tela mostra e a e2e cobra", () => {
    const exigidas = vagasExigidasPeloPacote(SEED, CATALOGO_DA_TELA, "atender");
    const excedente = exigidas - TETO_TOOLS_POR_AGENTE;
    expect(
      excedente,
      "a spec da e2e espera /faltam? 1 vaga/. Se virou 2, uma ferramenta nova entrou em " +
        '"atender" (a #1684 fez isso), ou uma do harness voltou a ser marcável: ajuste o ' +
        "seed da spec ou mova a ferramenta de pacote — o e2e de ~20 min agradece. Se virou " +
        "0 ou menos, a recusa sumiu e o caso da spec morreu em verde.",
    ).toBe(1);
  });
});
