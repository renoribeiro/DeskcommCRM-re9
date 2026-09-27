/**
 * A6 — nenhuma chamada ao modelo sai sem teto de tempo.
 *
 * Um provedor que aceita a conexão e não responde prendia o turno para sempre:
 * o worker parava nesse evento, a fila esperava, e o dreno devolvia o evento
 * como órfão — repetindo o turno. Agora toda chamada leva `abortSignal` com o
 * teto `LLM_CALL_TIMEOUT_MS` (padrão 90 s).
 *
 * Três provas: (1) o seam `runModelCall` aborta um provedor travado no teto da
 * config — e grava a falha — mesmo sem sinal de quem chamou; (2) o sinal de
 * quem chamou continua valendo junto do teto; (3) varredura pelo AST: toda
 * chamada a `generateText`/`generateObject`/`streamText`/`streamObject` do
 * produto passa `abortSignal` — chamada nova não esquece.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import { llmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/llm/credentials";
import {
  LLM_CALL_TIMEOUT_MS_PADRAO,
  lerTimeoutDeLlm,
  sinalDaChamadaAoModelo,
} from "@/lib/ai/tempo-da-chamada";

const ORG = "33333333-3333-4333-8333-333333333333";

function pool() {
  const inserts: string[] = [];
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [
          {
            llm: {
              provider: "anthropic",
              default_model: "claude-padrao",
              params: {},
              enabled_models: [],
              monthly_budget_cents: null,
            },
          },
        ],
      };
    }
    if (sql.includes("insert into llm_calls")) {
      inserts.push(sql);
      return { rows: [{ id: "call-1" }] };
    }
    return { rows: [] };
  });
  return { pool: { query } as never, inserts };
}

/** Provedor que aceita a chamada e só "responde" quando o sinal aborta. */
function registryTravado(visto: { sinal?: AbortSignal }) {
  const fabrica = () =>
    ({
      specificationVersion: "v3",
      provider: "anthropic",
      modelId: "claude-padrao",
      doGenerate: (opcoes: { abortSignal?: AbortSignal }) => {
        visto.sinal = opcoes.abortSignal;
        return new Promise((_, rejeitar) => {
          if (!opcoes.abortSignal) return; // sem sinal: trava para sempre
          opcoes.abortSignal.addEventListener("abort", () =>
            rejeitar(opcoes.abortSignal!.reason ?? new Error("aborted")),
          );
        });
      },
    }) as never;
  return { anthropic: fabrica, openai: fabrica, google: fabrica, openrouter: fabrica };
}

describe("o knob LLM_CALL_TIMEOUT_MS", () => {
  it("lê inteiro positivo e cai no padrão (90 s) para o resto — nunca lança", () => {
    expect(LLM_CALL_TIMEOUT_MS_PADRAO).toBe(90_000);
    expect(lerTimeoutDeLlm("30000")).toBe(30_000);
    expect(lerTimeoutDeLlm(1500)).toBe(1500);
    for (const lixo of [undefined, null, "", "0", "-5", "abc", "1.5"]) {
      expect(lerTimeoutDeLlm(lixo as never)).toBe(90_000);
    }
  });

  it("a config do seam carrega o teto lido do ambiente", () => {
    expect(llmEdgeConfigFromEnv({ LLM_CALL_TIMEOUT_MS: "1234" }).llmCallTimeoutMs).toBe(1234);
    expect(llmEdgeConfigFromEnv({}).llmCallTimeoutMs).toBe(90_000);
  });

  it("o sinal combinado dispara pelo teto OU pelo sinal de quem chamou", async () => {
    const externo = new AbortController();
    const s1 = sinalDaChamadaAoModelo(60_000, externo.signal);
    expect(s1.aborted).toBe(false);
    externo.abort(new Error("cancelado por quem chamou"));
    expect(s1.aborted).toBe(true);

    const s2 = sinalDaChamadaAoModelo(10);
    await new Promise((r) => setTimeout(r, 40));
    expect(s2.aborted).toBe(true);
  });
});

describe("runModelCall — provedor travado é abortado no teto", () => {
  it("sem sinal de quem chamou, a chamada leva teto, aborta e grava a falha", async () => {
    const { pool: db, inserts } = pool();
    const visto: { sinal?: AbortSignal } = {};
    const inicio = Date.now();
    const erro = await runModelCall(
      db,
      { anthropicApiKey: "sk-teste", cacheTtl: "1h", llmCallTimeoutMs: 50 },
      { tenantId: ORG, purpose: "agent_turn", messages: [{ role: "user", content: "oi" }] },
      { registry: registryTravado(visto) },
    ).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(Error);
    expect(visto.sinal, "a chamada saiu sem abortSignal").toBeDefined();
    expect(Date.now() - inicio).toBeLessThan(5_000);
    expect(inserts.some((sql) => sql.includes("'erro'"))).toBe(true);
  });

  it("o sinal de quem chamou continua valendo junto do teto", async () => {
    const { pool: db } = pool();
    const visto: { sinal?: AbortSignal } = {};
    const externo = new AbortController();
    const promessa = runModelCall(
      db,
      { anthropicApiKey: "sk-teste", cacheTtl: "1h", llmCallTimeoutMs: 60_000 },
      {
        tenantId: ORG,
        purpose: "agent_turn",
        messages: [{ role: "user", content: "oi" }],
        abortSignal: externo.signal,
      },
      { registry: registryTravado(visto) },
    ).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 20));
    externo.abort(new Error("turno cancelado"));
    expect(await promessa).toBeInstanceOf(Error);
    expect(visto.sinal?.aborted).toBe(true);
  });
});

// ─── Varredura: toda chamada ao SDK passa abortSignal ─────────────────────────

const RAIZ = join(__dirname, "..", "..");
const DIRS = ["app", "lib", "workers"];
const FUNCOES = new Set(["generateText", "generateObject", "streamText", "streamObject"]);

function arquivos(dir: string, saida: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    if (nome === "node_modules" || nome.startsWith(".")) continue;
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) arquivos(caminho, saida);
    else if (/\.(ts|tsx)$/.test(nome) && !/\.test\.tsx?$/.test(nome)) saida.push(caminho);
  }
  return saida;
}

function chamadasSemTeto(caminho: string): string[] {
  const fonte = readFileSync(caminho, "utf8");
  if (![...FUNCOES].some((f) => fonte.includes(`${f}(`))) return [];
  const sf = ts.createSourceFile(caminho, fonte, ts.ScriptTarget.Latest, true);
  const faltas: string[] = [];
  const visitar = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && FUNCOES.has(n.expression.text)) {
      const arg = n.arguments[0];
      const temSinal =
        arg !== undefined &&
        ts.isObjectLiteralExpression(arg) &&
        arg.properties.some(
          (p) =>
            (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
            ts.isIdentifier(p.name) &&
            p.name.text === "abortSignal",
        );
      if (!temSinal) {
        const linha = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
        faltas.push(`${relative(RAIZ, caminho)}:${linha} ${n.expression.text}`);
      }
    }
    ts.forEachChild(n, visitar);
  };
  visitar(sf);
  return faltas;
}

describe("varredura — nenhuma chamada ao modelo sem abortSignal", () => {
  const todos = DIRS.flatMap((d) => arquivos(join(RAIZ, d)));

  it("GUARDA DE VACUIDADE: a varredura acha as chamadas conhecidas", () => {
    const comChamada = todos.filter((c) => {
      const f = readFileSync(c, "utf8");
      return [...FUNCOES].some((fn) => f.includes(`${fn}(`));
    });
    const rel = comChamada.map((c) => relative(RAIZ, c));
    expect(rel).toContain("lib/agent-engine/edge/llm/run-model-call.ts");
    expect(rel).toContain("workers/ai-response-worker.ts");
  });

  it("toda chamada a generateText/generateObject/streamText/streamObject passa abortSignal", () => {
    const faltas = todos.flatMap(chamadasSemTeto);
    expect(
      faltas,
      "Chamada ao modelo sem `abortSignal`: um provedor travado prende o turno e a fila. " +
        "Use `sinalDaChamadaAoModelo()` de `lib/ai/tempo-da-chamada.ts`.",
    ).toEqual([]);
  });
});
