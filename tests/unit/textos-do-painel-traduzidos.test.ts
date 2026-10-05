/**
 * Os avisos de /admin que nomeiam o PAINEL da instalação (Dokploy ou Docker
 * Manager da Hostinger) moram em `lib/deploy/painel.ts`, e a tela os passa ao
 * tradutor por referência — `traduzir(TEXTOS_DO_PAINEL[painel].x)`. O guarda de
 * tradução das telas lê LITERAIS no AST e não enxerga essas chaves. Este teste
 * cobra o que ele não alcança: toda frase de todo painel tem espanhol e chinês,
 * e nenhum painel fala do outro.
 */
import { describe, expect, it } from "vitest";

import { TEXTOS_DO_PAINEL, painelDaInstalacao, type Painel } from "@/lib/deploy/painel";
import { DICIONARIO } from "@/lib/i18n/dicionario";
import zhCN from "@/lib/i18n/traducoes/zh-CN.json";

const ZH = zhCN as Record<string, string>;

describe("textos do painel da instalação", () => {
  for (const [painel, textos] of Object.entries(TEXTOS_DO_PAINEL)) {
    for (const [campo, frase] of Object.entries(textos)) {
      it(`${painel}.${campo} tem espanhol e chinês`, () => {
        expect(DICIONARIO[frase]?.es, `sem espanhol: ${frase}`).toBeTruthy();
        expect(ZH[frase], `sem chinês: ${frase}`).toBeTruthy();
      });
    }
  }

  it("nenhum painel ensina o caminho do outro", () => {
    expect(Object.values(TEXTOS_DO_PAINEL.hostinger).join(" ")).not.toMatch(/Dokploy|Environment|Deploy\b/);
    expect(Object.values(TEXTOS_DO_PAINEL.dokploy).join(" ")).not.toMatch(/Hostinger/);
  });

  it("só os dois valores que os composes gravam viram painel", () => {
    const esperado: Record<string, Painel | null> = {
      dokploy: "dokploy",
      hostinger: "hostinger",
      "": null,
      Dokploy: null,
      kit: null,
    };
    for (const [valor, painel] of Object.entries(esperado)) {
      expect(painelDaInstalacao(valor)).toBe(painel);
    }
    expect(painelDaInstalacao(undefined)).toBeNull();
  });
});
