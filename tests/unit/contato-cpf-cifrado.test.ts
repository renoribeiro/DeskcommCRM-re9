/**
 * A3 — cadastrar contato com CPF grava as DUAS colunas, e sem chave recusa.
 *
 * Antes: o handler chamava a RPC `encrypt_cpf`, que nunca existiu; o erro era
 * engolido, o insert levava só `cpf_hash`, e o CHECK
 * `contacts_cpf_consistency` ((cpf_encrypted is null) = (cpf_hash is null))
 * recusava a linha — todo cadastro com CPF falhava com 500.
 *
 * O banco falso abaixo aplica ESSE CHECK de verdade, e a leitura decifra o que
 * o insert gravou — ida e volta pelo formato `\x<hex>` do PostgREST.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({ chave: "" }));
vi.mock("@/lib/env", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/env")>();
  return {
    env: new Proxy(real.env, {
      get: (alvo, prop) =>
        prop === "CPF_ENCRYPTION_KEY" ? estado.chave : Reflect.get(alvo, prop),
    }),
  };
});
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));

import { ApiError } from "@/lib/api/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import {
  createContactHandler,
  getContactHandler,
  patchContactHandler,
} from "@/app/api/v1/contacts/_handler";

const ORG = "c9f00000-0000-4000-8000-000000000001";
const USUARIO = "c9f00000-0000-4000-8000-0000000000a1";
const CONTATO = "c9f00000-0000-4000-8000-0000000000c1";
const CHAVE = "q5o1kB7sI0Qm0l3yVt2t8xJQv2cS8m9eZ0vKqRk3o8Y=";

type Linha = Record<string, unknown>;

/** Banco mínimo: `contacts` com o CHECK de consistência do CPF; o resto responde vazio. */
function banco() {
  const linhas: Linha[] = [];
  const violacoes: string[] = [];

  function checar(l: Linha): { code: string; message: string } | null {
    const temHash = l.cpf_hash != null;
    const temCifra = l.cpf_encrypted != null;
    if (temHash !== temCifra) {
      violacoes.push("contacts_cpf_consistency");
      return { code: "23514", message: 'violates check constraint "contacts_cpf_consistency"' };
    }
    return null;
  }

  function cadeia(tabela: string) {
    let op: "select" | "insert" | "update" = "select";
    let payload: Linha | null = null;
    let colunas = "";
    const filtros: Record<string, unknown> = {};
    const resolver = async () => {
      if (tabela === "user_organizations") {
        return { data: { role: "manager" }, error: null };
      }
      if (tabela !== "contacts") return { data: null, error: null };
      if (op === "insert" && payload) {
        const erro = checar(payload);
        if (erro) return { data: null, error: erro };
        const nova = { id: CONTATO, ...payload };
        linhas.push(nova);
        return { data: nova, error: null };
      }
      const alvo = linhas.find((l) => l.id === filtros.id) ?? linhas[0] ?? null;
      if (op === "update" && payload && alvo) {
        const erro = checar({ ...alvo, ...payload });
        if (erro) return { data: null, error: erro };
        Object.assign(alvo, payload);
      }
      if (!alvo) return { data: null, error: null };
      if (colunas.trim() === "cpf_encrypted") return { data: { cpf_encrypted: alvo.cpf_encrypted }, error: null };
      const { cpf_encrypted: _omitida, ...semCifra } = alvo;
      void _omitida;
      return { data: { consent: {}, tags: [], ...semCifra }, error: null };
    };
    const c = {
      select: (cols?: string) => {
        if (cols) colunas = cols;
        return c;
      },
      insert: (l: Linha) => {
        op = "insert";
        payload = l;
        return c;
      },
      update: (l: Linha) => {
        op = "update";
        payload = l;
        return c;
      },
      eq: (col: string, v: unknown) => {
        filtros[col] = v;
        return c;
      },
      in: () => c,
      is: () => c,
      not: () => c,
      order: () => c,
      limit: () => c,
      single: resolver,
      maybeSingle: resolver,
      then: (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(ok, falha),
    };
    return c;
  }

  const supabase = {
    from: (t: string) => cadeia(t),
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
  };
  return { supabase, linhas, violacoes };
}

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: USUARIO, role: "manager" },
  requestId: "req-cpf",
} as HandlerCtx;

afterEach(() => {
  estado.chave = "";
});

describe("contato com CPF — cifra e hash juntos, ou recusa clara", () => {
  it("create grava cpf_hash E cpf_encrypted (`\\x…`), e o CHECK do banco aceita", async () => {
    estado.chave = CHAVE;
    const db = banco();
    await createContactHandler(db.supabase as never, ctx, {
      name: "Ana",
      cpf: "529.982.247-25",
      source: "manual",
    } as never);

    expect(db.violacoes).toEqual([]);
    expect(db.linhas).toHaveLength(1);
    expect(db.linhas[0]!.cpf_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(db.linhas[0]!.cpf_encrypted).toMatch(/^\\x01[0-9a-f]+$/);
    // Nenhuma RPC de cifra: ela nunca existiu no schema.
    expect(db.supabase.rpc).not.toHaveBeenCalledWith("encrypt_cpf", expect.anything());
  });

  it("get com propósito decifra o que o create gravou (ida e volta pelo bytea)", async () => {
    estado.chave = CHAVE;
    const db = banco();
    await createContactHandler(db.supabase as never, ctx, {
      name: "Ana",
      cpf: "529.982.247-25",
      source: "manual",
    } as never);

    const lido = await getContactHandler(db.supabase as never, ctx, {
      contactId: CONTATO,
      decryptPurpose: "atendimento",
    });
    expect(lido.cpf_available).toBe(true);
    expect(lido.cpf_decrypted).toBe("52998224725");
    expect(db.supabase.rpc).not.toHaveBeenCalledWith("decrypt_cpf", expect.anything());
    // A cifra não vaza na resposta.
    expect(lido).not.toHaveProperty("cpf_encrypted");
  });

  it("sem CPF_ENCRYPTION_KEY o create recusa com 503 e nada é gravado", async () => {
    estado.chave = "";
    const db = banco();
    const tentativa = createContactHandler(db.supabase as never, ctx, {
      name: "Ana",
      cpf: "529.982.247-25",
      source: "manual",
    } as never);
    await expect(tentativa).rejects.toBeInstanceOf(ApiError);
    await expect(tentativa).rejects.toMatchObject({
      status: 503,
      code: "cpf_encryption_unavailable",
    });
    expect(db.linhas).toHaveLength(0);
    expect(db.violacoes).toEqual([]);
  });

  it("sem chave, contato SEM CPF continua sendo criado", async () => {
    estado.chave = "";
    const db = banco();
    await createContactHandler(db.supabase as never, ctx, { name: "Bia", source: "manual" } as never);
    expect(db.linhas).toHaveLength(1);
    expect(db.linhas[0]).not.toHaveProperty("cpf_hash");
  });

  it("patch com CPF grava as duas colunas; sem chave recusa com 503", async () => {
    estado.chave = CHAVE;
    const db = banco();
    await createContactHandler(db.supabase as never, ctx, { name: "Ana", source: "manual" } as never);
    await patchContactHandler(db.supabase as never, ctx, CONTATO, { cpf: "52998224725" } as never);
    expect(db.violacoes).toEqual([]);
    expect(db.linhas[0]!.cpf_encrypted).toMatch(/^\\x01/);

    estado.chave = "";
    await expect(
      patchContactHandler(db.supabase as never, ctx, CONTATO, { cpf: "52998224725" } as never),
    ).rejects.toMatchObject({ status: 503, code: "cpf_encryption_unavailable" });
  });
});
