import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Formulário com `action="/caminho"` literal só funciona se o caminho existir.
 *
 * Achado da auditoria de 27/09/2026: a tela de aceitar convite postava o "Sair"
 * para `/api/auth/signout`, que nunca existiu — o botão devolvia 404 justamente
 * para quem estava logado com o e-mail errado. O conserto usa a server action
 * `signOut`; este teste impede que outro formulário volte a apontar para o nada.
 */
const RAIZ = path.resolve(__dirname, "../..");

function arquivos(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : arquivos(p);
    return /\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name) ? [p] : [];
  });
}

/** `/api/v1/x/y` existe se houver app/api/v1/x/y/route.ts (ou page.tsx para tela). */
function rotaExiste(caminho: string): boolean {
  const semQuery = caminho.split(/[?#]/)[0]!.replace(/\/+$/, "");
  const base = path.join(RAIZ, "app", ...semQuery.split("/").filter(Boolean));
  return ["route.ts", "page.tsx"].some((f) => fs.existsSync(path.join(base, f)));
}

describe("action literal de <form> aponta para rota que existe", () => {
  it("nenhum formulário em app/ ou components/ posta para um caminho inexistente", () => {
    const quebrados: string[] = [];
    for (const dir of ["app", "components"]) {
      for (const arq of arquivos(path.join(RAIZ, dir))) {
        const texto = fs.readFileSync(arq, "utf8");
        for (const m of texto.matchAll(/<form[^>]*\saction="(\/[^"]*)"/g)) {
          if (!rotaExiste(m[1]!)) quebrados.push(`${path.relative(RAIZ, arq)} → ${m[1]}`);
        }
      }
    }
    expect(quebrados).toEqual([]);
  });

  it("a tela de convite com e-mail errado sai pela server action signOut", () => {
    const texto = fs.readFileSync(path.join(RAIZ, "app/team/accept-invite/[token]/page.tsx"), "utf8");
    expect(texto).toContain("<form action={signOut}");
    expect(texto).not.toContain("/api/auth/signout");
  });
});
