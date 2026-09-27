/**
 * R1 — o reaper de órfãos só devolve à fila o claim VELHO que ele leu.
 *
 * A corrida: a instância Y lê o evento preso (`processing`, attempts=0,
 * `updated_at` além da janela). Antes do update de Y, a instância Z devolve o
 * mesmo preso à fila (attempts=1) e a instância X o reclama de novo — a linha
 * volta a `processing`, com posse fresca. O update de Y filtrava só `id` +
 * `status = 'processing'`, casava com o claim VIVO de X e o devolvia a
 * `pending`: o evento rodava de novo em paralelo.
 *
 * O banco falso APLICA de verdade `eq` e `lt` nos UPDATEs, e a mutação de Z+X
 * acontece entre a leitura dos presos e o update do reaper.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: {} }));

const handlers = vi.fn();
const dispatch = vi.fn();
vi.mock("@/lib/event-log/dispatcher", () => ({
  getRegisteredHandlers: () => handlers(),
  dispatchEvent: (row: unknown) => dispatch(row),
}));

import { drainEventLog } from "@/lib/event-log/drain";

type Linha = Record<string, unknown>;

function banco(evento: Linha, entreLeituraEUpdate: (l: Linha) => void) {
  const tabela = new Map<string, Linha>([[evento.id as string, { ...evento }]]);
  let jaLeuPresos = false;

  function cadeia(nome: string) {
    let op: "select" | "update" | "insert" = "select";
    let patch: Linha | null = null;
    const filtros: Array<[string, string, unknown]> = [];
    const casa = (l: Linha) =>
      filtros.every(([tipo, col, v]) => {
        if (tipo === "eq") return l[col] === v;
        if (tipo === "lt") return String(l[col]) < String(v);
        if (tipo === "in") return (v as unknown[]).includes(l[col]);
        return true;
      });
    const executar = () => {
      if (nome !== "event_log") return { data: null, error: null };
      if (op === "update" && patch) {
        const tocadas = [...tabela.values()].filter(casa);
        for (const l of tocadas) Object.assign(l, patch);
        return { data: tocadas.map((l) => ({ id: l.id })), error: null };
      }
      const resultado = [...tabela.values()].filter(casa).map((l) => ({ ...l }));
      const pedePresos = filtros.some(([t, c, v]) => t === "eq" && c === "status" && v === "processing");
      if (pedePresos && !jaLeuPresos) {
        jaLeuPresos = true;
        // Z reaper + X claim acontecem DEPOIS da leitura de Y.
        entreLeituraEUpdate(tabela.get(evento.id as string)!);
      }
      return { data: resultado, error: null };
    };
    const self: Record<string, unknown> = {
      select: () => self,
      update: (p: Linha) => {
        op = "update";
        patch = p;
        return self;
      },
      insert: (p: Linha) => {
        op = "insert";
        patch = p;
        return self;
      },
      eq: (c: string, v: unknown) => {
        filtros.push(["eq", c, v]);
        return self;
      },
      lt: (c: string, v: unknown) => {
        filtros.push(["lt", c, v]);
        return self;
      },
      in: (c: string, v: unknown) => {
        filtros.push(["in", c, v]);
        return self;
      },
      neq: () => self,
      or: () => self,
      order: () => self,
      limit: () => self,
      maybeSingle: () => self,
      then: (resolve: (r: unknown) => unknown) => resolve(executar()),
    };
    return self;
  }
  return { admin: { from: (t: string) => cadeia(t) }, tabela };
}

const VELHO = new Date(Date.now() - 60 * 60_000).toISOString();

const PRESO = {
  id: "ev-1",
  organization_id: "org-1",
  event_type: "knowledge_source.updated",
  entity_kind: "ai_knowledge_source",
  entity_id: "ks-1",
  payload: {},
  metadata: {},
  consumed_by: [],
  attempts: 0,
  status: "processing",
  updated_at: VELHO,
  created_at: VELHO,
};

beforeEach(() => {
  handlers.mockReset();
  dispatch.mockReset();
  handlers.mockReturnValue([{ key: "k", events: ["knowledge_source.updated"] }]);
});

describe("drainEventLog — reaper x claim fresco", () => {
  it("claim fresco de outra instância (attempts+1) NÃO é devolvido à fila", async () => {
    const db = banco(PRESO, (l) => {
      Object.assign(l, { status: "processing", attempts: 1, updated_at: new Date().toISOString() });
    });

    await drainEventLog(db.admin as never);

    const linha = db.tabela.get("ev-1")!;
    expect(linha.status).toBe("processing");
    expect(linha.attempts).toBe(1);
    expect(linha.last_error).toBeUndefined();
  });

  it("posse trocada (attempts+1) com updated_at ainda velho — relógio torto — NÃO é devolvida", async () => {
    // Cada guarda vale sozinho: o `updated_at` do claim sai do relógio da
    // instância, e um relógio atrasado não pode reabrir a corrida.
    const db = banco(PRESO, (l) => {
      Object.assign(l, { status: "processing", attempts: 1 });
    });

    await drainEventLog(db.admin as never);

    const linha = db.tabela.get("ev-1")!;
    expect(linha.status).toBe("processing");
    expect(linha.attempts).toBe(1);
  });

  it("linha retocada dentro da janela (mesmo attempts, updated_at fresco) NÃO é devolvida", async () => {
    const db = banco(PRESO, (l) => {
      Object.assign(l, { updated_at: new Date().toISOString() });
    });

    await drainEventLog(db.admin as never);

    const linha = db.tabela.get("ev-1")!;
    expect(linha.status).toBe("processing");
    expect(linha.attempts).toBe(0);
  });

  it("o preso que continua preso é devolvido à fila, contando a tentativa", async () => {
    const db = banco(PRESO, () => {});
    dispatch.mockResolvedValue([{ consumer_key: "k", status: "ok" }]);

    await drainEventLog(db.admin as never);

    const linha = db.tabela.get("ev-1")!;
    expect(linha.attempts).toBe(1);
    expect(linha.status).not.toBe("processing");
  });
});
