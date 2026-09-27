/**
 * A7 — o desfecho de um evento só é gravado por quem ainda tem a POSSE dele.
 *
 * O cenário: o worker A reclama o evento (`processing`, attempts=0) e o handler
 * demora mais que a janela de órfão (10 min). O reaper devolve o evento à fila
 * contando a tentativa (attempts=1); o worker B o reclama e processa. Quando o
 * handler de A enfim volta, a gravação final de A — que filtrava só por `id` —
 * sobrescrevia o estado de B: `done` virava `pending`, ou abria aviso de evento
 * morto de um evento que deu certo.
 *
 * O banco falso aqui APLICA os filtros `eq` de verdade nos UPDATEs: o que se
 * prova é que a gravação tardia não casa com a linha, não que o código "pediu"
 * um filtro.
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

function bancoComEstado(evento: Linha) {
  const tabela = new Map<string, Linha>([[evento.id as string, { ...evento }]]);
  const avisos: Linha[] = [];
  const consultasDePresos: Array<{ limite: number | null }> = [];

  function cadeia(nome: string) {
    let op: "select" | "update" | "insert" = "select";
    let patch: Linha | null = null;
    let limite: number | null = null;
    const filtros: Array<[string, string, unknown]> = [];

    const casa = (l: Linha) =>
      filtros.every(([tipo, col, v]) => {
        if (tipo === "eq") return l[col] === v;
        if (tipo === "in") return (v as unknown[]).includes(l[col]);
        return true; // lt/or: o teste não depende deles
      });

    const executar = () => {
      if (nome === "agent_inbox_items") {
        if (op === "insert" && patch) avisos.push(patch);
        return { data: null, error: null };
      }
      if (op === "update" && patch) {
        const tocadas = [...tabela.values()].filter(casa);
        for (const l of tocadas) Object.assign(l, patch);
        return { data: tocadas.map((l) => ({ id: l.id })), error: null };
      }
      const pedePresos = filtros.some(([t, c, v]) => t === "eq" && c === "status" && v === "processing");
      if (pedePresos) consultasDePresos.push({ limite });
      return { data: [...tabela.values()].filter(casa).map((l) => ({ ...l })), error: null };
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
      neq: () => self,
      lt: (c: string, v: unknown) => {
        filtros.push(["lt", c, v]);
        return self;
      },
      or: () => self,
      in: (c: string, v: unknown) => {
        filtros.push(["in", c, v]);
        return self;
      },
      order: () => self,
      limit: (n: number) => {
        limite = n;
        return self;
      },
      maybeSingle: () => self,
      then: (resolve: (r: unknown) => unknown) => resolve(executar()),
    };
    return self;
  }

  return { admin: { from: (t: string) => cadeia(t) }, tabela, avisos, consultasDePresos };
}

const EVENTO = {
  id: "ev-1",
  organization_id: "org-1",
  event_type: "knowledge_source.updated",
  entity_kind: "ai_knowledge_source",
  entity_id: "ks-1",
  payload: {},
  metadata: {},
  consumed_by: [],
  attempts: 0,
  status: "pending",
  created_at: new Date().toISOString(),
};

beforeEach(() => {
  handlers.mockReset();
  dispatch.mockReset();
  handlers.mockReturnValue([{ key: "k", events: ["knowledge_source.updated"] }]);
});

describe("drainEventLog — posse do evento", () => {
  it("handler lento que perdeu a posse NÃO sobrescreve o desfecho de quem reclamou depois", async () => {
    const db = bancoComEstado(EVENTO);
    dispatch.mockImplementation(async () => {
      // Enquanto o handler de A "demora": o reaper devolveu (attempts=1) e B
      // reclamou e concluiu.
      Object.assign(db.tabela.get("ev-1")!, { status: "done", attempts: 1, consumed_by: ["k"] });
      return [{ consumer_key: "k", status: "error", detail: "boom tardio" }];
    });

    const resumo = await drainEventLog(db.admin as never);

    const linha = db.tabela.get("ev-1")!;
    expect(linha.status).toBe("done");
    expect(linha.attempts).toBe(1);
    expect(linha.last_error).toBeUndefined();
    expect(resumo.failed).toBe(0);
    expect(resumo.perdidos).toBe(1);
  });

  it("desfecho tardio de erro no limite NÃO abre aviso de evento morto", async () => {
    const db = bancoComEstado({ ...EVENTO, attempts: 4 });
    dispatch.mockImplementation(async () => {
      Object.assign(db.tabela.get("ev-1")!, { status: "processing", attempts: 5 });
      return [{ consumer_key: "k", status: "error", detail: "boom" }];
    });

    const resumo = await drainEventLog(db.admin as never);

    expect(db.tabela.get("ev-1")!.status).toBe("processing");
    expect(resumo.dead).toBe(0);
    expect(db.avisos).toHaveLength(0);
  });

  it("quem ainda tem a posse grava normalmente", async () => {
    const db = bancoComEstado(EVENTO);
    dispatch.mockResolvedValue([{ consumer_key: "k", status: "ok" }]);

    const resumo = await drainEventLog(db.admin as never);

    expect(db.tabela.get("ev-1")!.status).toBe("done");
    expect(db.tabela.get("ev-1")!.consumed_by).toEqual(["k"]);
    expect(resumo.done).toBe(1);
    expect(resumo.perdidos ?? 0).toBe(0);
  });

  it("a recuperação de presos tem teto por tique", async () => {
    const db = bancoComEstado(EVENTO);
    dispatch.mockResolvedValue([{ consumer_key: "k", status: "ok" }]);

    await drainEventLog(db.admin as never);

    expect(db.consultasDePresos).toHaveLength(1);
    expect(db.consultasDePresos[0]!.limite).not.toBeNull();
    expect(db.consultasDePresos[0]!.limite!).toBeLessThanOrEqual(100);
  });
});
