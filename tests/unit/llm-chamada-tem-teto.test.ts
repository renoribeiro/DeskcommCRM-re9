/**
 * A6/R2 — nenhuma chamada ao modelo sai sem teto de tempo, e o teto tem a
 * ESCALA certa.
 *
 * Um provedor que aceita a conexão e não responde prendia o turno para sempre:
 * o worker parava nesse evento, a fila esperava, e o dreno devolvia o evento
 * como órfão — repetindo o turno. São dois tetos, e cada um mede uma coisa:
 *
 * - `LLM_CALL_TIMEOUT_MS` (90 s) — UMA requisição HTTP ao provedor, no `fetch`
 *   da fábrica. Não conta as ferramentas entre um passo e outro.
 * - `LLM_TURN_TIMEOUT_MS` (300 s) — o turno inteiro, como `abortSignal` do
 *   `generateText`; abaixo de `QUEUE_VISIBILITY_TIMEOUT_MS` (600 s).
 *
 * Com um sinal só de 90 s cobrindo o `generateText` inteiro, um turno legítimo
 * de vários passos com ferramentas no meio era abortado sem que nenhuma
 * requisição tivesse travado — o caso "turno de vários passos" abaixo prova.
 *
 * Varredura pelo AST: toda chamada a `generateText`/`generateObject`/
 * `streamText`/`streamObject`/`embed`/`embedMany` (importados de `ai`) passa
 * `abortSignal`, e toda fábrica `createAnthropic`/`createOpenAI`/
 * `createGoogleGenerativeAI` recebe `fetch` — chamada nova não esquece.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { generateText, tool } from "ai";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import { llmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/llm/credentials";
import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { loadEnv } from "@/lib/agent-engine/env";
import {
  LLM_CALL_TIMEOUT_MS_PADRAO,
  LLM_TURN_TIMEOUT_MS_PADRAO,
  QUEUE_VISIBILITY_TIMEOUT_MS_PADRAO,
  fetchComTetoPorRequisicao,
  lerTetoDoTurno,
  lerTimeoutDeLlm,
  sinalDeUmaChamada,
  sinalDoTurno,
  tetoDoTurnoAbaixoDaVisibilidade,
} from "@/lib/ai/tempo-da-chamada";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

/** `fetch` que nunca responde — só rejeita quando o sinal da requisição dispara. */
function fetchTravado() {
  return vi.fn(
    (_input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_, rejeitar) => {
        init?.signal?.addEventListener("abort", () => rejeitar(init.signal!.reason ?? new Error("aborted")));
      }),
  );
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resposta da API de mensagens da Anthropic, no formato que o SDK lê. */
function respostaAnthropic(content: unknown[], stop: string): Response {
  return new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-padrao",
      content,
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("os knobs LLM_CALL_TIMEOUT_MS e LLM_TURN_TIMEOUT_MS", () => {
  it("lê inteiro positivo e cai no padrão para o resto — nunca lança", () => {
    expect(LLM_CALL_TIMEOUT_MS_PADRAO).toBe(90_000);
    expect(LLM_TURN_TIMEOUT_MS_PADRAO).toBe(300_000);
    expect(lerTimeoutDeLlm("30000")).toBe(30_000);
    expect(lerTimeoutDeLlm(1500)).toBe(1500);
    expect(lerTetoDoTurno("120000")).toBe(120_000);
    for (const lixo of [undefined, null, "", "0", "-5", "abc", "1.5"]) {
      expect(lerTimeoutDeLlm(lixo as never)).toBe(90_000);
      expect(lerTetoDoTurno(lixo as never)).toBe(300_000);
    }
  });

  it("o teto do turno nasce ABAIXO da janela de visibilidade da fila, e o worker declara os dois", () => {
    const env = loadEnv({
      SUPABASE_DB_URL: "postgres://u:p@localhost:5432/db",
      NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
      SUPABASE_SERVICE_ROLE_KEY: "service-role",
    } as never);
    expect(env.QUEUE_VISIBILITY_TIMEOUT_MS).toBe(QUEUE_VISIBILITY_TIMEOUT_MS_PADRAO);
    expect(env.LLM_TURN_TIMEOUT_MS).toBe(LLM_TURN_TIMEOUT_MS_PADRAO);
    expect(env.LLM_CALL_TIMEOUT_MS).toBe(LLM_CALL_TIMEOUT_MS_PADRAO);
    expect(env.LLM_TURN_TIMEOUT_MS).toBeLessThan(env.QUEUE_VISIBILITY_TIMEOUT_MS);
    expect(env.LLM_CALL_TIMEOUT_MS).toBeLessThan(env.LLM_TURN_TIMEOUT_MS);
    expect(llmEdgeConfigFromEnv(env).llmTurnTimeoutMs).toBe(300_000);
  });

  it("configuração que inverte a relação é corrigida para 90% da janela", () => {
    expect(tetoDoTurnoAbaixoDaVisibilidade(300_000, 600_000)).toBe(300_000);
    expect(tetoDoTurnoAbaixoDaVisibilidade(900_000, 600_000)).toBe(540_000);
    expect(tetoDoTurnoAbaixoDaVisibilidade(600_000, 600_000)).toBe(540_000);
    expect(tetoDoTurnoAbaixoDaVisibilidade(900_000, undefined)).toBe(900_000);
    expect(
      llmEdgeConfigFromEnv({ LLM_TURN_TIMEOUT_MS: "900000", QUEUE_VISIBILITY_TIMEOUT_MS: 600_000 })
        .llmTurnTimeoutMs,
    ).toBe(540_000);
  });

  it("a config do seam carrega os dois tetos lidos do ambiente", () => {
    const cfg = llmEdgeConfigFromEnv({ LLM_CALL_TIMEOUT_MS: "1234", LLM_TURN_TIMEOUT_MS: "5678" });
    expect(cfg.llmCallTimeoutMs).toBe(1234);
    expect(cfg.llmTurnTimeoutMs).toBe(5678);
    expect(llmEdgeConfigFromEnv({}).llmCallTimeoutMs).toBe(90_000);
    expect(llmEdgeConfigFromEnv({}).llmTurnTimeoutMs).toBe(300_000);
  });

  it("os sinais disparam pelo teto OU pelo sinal de quem chamou", async () => {
    const externo = new AbortController();
    const s1 = sinalDoTurno(60_000, externo.signal);
    const s3 = sinalDeUmaChamada(60_000, externo.signal);
    expect(s1.aborted).toBe(false);
    externo.abort(new Error("cancelado por quem chamou"));
    expect(s1.aborted).toBe(true);
    expect(s3.aborted).toBe(true);

    const s2 = sinalDoTurno(10);
    const s4 = sinalDeUmaChamada(10);
    await esperar(40);
    expect(s2.aborted).toBe(true);
    expect(s4.aborted).toBe(true);
  });
});

describe("teto POR REQUISIÇÃO no fetch do provedor", () => {
  it("fetchComTetoPorRequisicao aborta a requisição travada no teto", async () => {
    const travado = fetchTravado();
    const inicio = Date.now();
    const erro = await fetchComTetoPorRequisicao(travado as never, 50)("https://x.test/v1").catch(
      (e: unknown) => e,
    );
    expect(erro).toBeDefined();
    expect(Date.now() - inicio).toBeLessThan(2_000);
  });

  it("fetchComTetoPorRequisicao preserva o sinal que o SDK já passa (o do turno)", async () => {
    const travado = fetchTravado();
    const turno = new AbortController();
    const promessa = fetchComTetoPorRequisicao(travado as never, 60_000)("https://x.test/v1", {
      signal: turno.signal,
    }).catch((e: unknown) => e);
    turno.abort(new Error("turno acabou"));
    expect(await promessa).toBeDefined();
  });

  it("o registry padrão aborta a requisição travada no LLM_CALL_TIMEOUT_MS, antes do teto do turno", async () => {
    vi.stubGlobal("fetch", fetchTravado());
    const modelo = createDefaultRegistry({ llmCallTimeoutMs: 80 }).anthropic!("sk-teste", "claude-padrao");
    const inicio = Date.now();
    const erro = await generateText({
      model: modelo,
      prompt: "oi",
      maxRetries: 0,
      abortSignal: sinalDoTurno(3_000),
    }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(Error);
    expect(Date.now() - inicio, "abortou pelo teto do turno, não pelo da requisição").toBeLessThan(1_500);
  });
});

describe("runModelCall — provedor travado é abortado no teto", () => {
  it("sem sinal de quem chamou, o turno leva teto (LLM_TURN_TIMEOUT_MS), aborta e grava a falha", async () => {
    const { pool: db, inserts } = pool();
    const visto: { sinal?: AbortSignal } = {};
    const inicio = Date.now();
    const erro = await runModelCall(
      db,
      { anthropicApiKey: "sk-teste", cacheTtl: "1h", llmTurnTimeoutMs: 50 },
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
      { anthropicApiKey: "sk-teste", cacheTtl: "1h", llmTurnTimeoutMs: 60_000 },
      {
        tenantId: ORG,
        purpose: "agent_turn",
        messages: [{ role: "user", content: "oi" }],
        abortSignal: externo.signal,
      },
      { registry: registryTravado(visto) },
    ).catch((e: unknown) => e);
    await esperar(20);
    externo.abort(new Error("turno cancelado"));
    expect(await promessa).toBeInstanceOf(Error);
    expect(visto.sinal?.aborted).toBe(true);
  });
});

describe("runModelCall — turno de vários passos não é abortado pelo teto por requisição", () => {
  it("cada requisição cabe no LLM_CALL_TIMEOUT_MS; o turno inteiro (com ferramenta lenta) passa dele e conclui", async () => {
    let chamadas = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: { signal?: AbortSignal }) => {
        chamadas += 1;
        await esperar(20);
        init?.signal?.throwIfAborted();
        return chamadas === 1
          ? respostaAnthropic([{ type: "tool_use", id: "toolu_1", name: "consultar", input: {} }], "tool_use")
          : respostaAnthropic([{ type: "text", text: "pronto" }], "end_turn");
      }),
    );
    const { pool: db } = pool();
    const consultar = tool({
      description: "consulta lenta",
      inputSchema: z.object({}),
      execute: async () => {
        await esperar(400); // mais que o teto por requisição
        return { ok: true };
      },
    });

    const { result } = await runModelCall(
      db,
      { anthropicApiKey: "sk-teste", cacheTtl: "1h", llmCallTimeoutMs: 200, llmTurnTimeoutMs: 10_000 },
      {
        tenantId: ORG,
        purpose: "agent_turn",
        messages: [{ role: "user", content: "oi" }],
        tools: { consultar },
        maxSteps: 3,
      },
    );

    expect(chamadas).toBe(2);
    expect(result.text).toBe("pronto");
  });
});

// ─── Varredura: toda chamada ao SDK passa abortSignal, toda fábrica passa fetch ─

const RAIZ = join(__dirname, "..", "..");
const DIRS = ["app", "lib", "workers"];
const FUNCOES = new Set(["generateText", "generateObject", "streamText", "streamObject", "embed", "embedMany"]);
const FABRICAS = new Set(["createAnthropic", "createOpenAI", "createGoogleGenerativeAI"]);
const PACOTES_DE_FABRICA = new Set(["@ai-sdk/anthropic", "@ai-sdk/openai", "@ai-sdk/google"]);

function arquivos(dir: string, saida: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    if (nome === "node_modules" || nome.startsWith(".")) continue;
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) arquivos(caminho, saida);
    else if (/\.(ts|tsx)$/.test(nome) && !/\.test\.tsx?$/.test(nome)) saida.push(caminho);
  }
  return saida;
}

/**
 * Nomes locais importados de um conjunto de módulos, filtrados pelo nome
 * ORIGINAL. Casar pelo import (e não pelo identificador solto) é o que deixa
 * `embed` na lista: `const embed = deps?.embed ?? embedText` não é o `embed`
 * do SDK, e a varredura por nome o acusaria.
 */
function importados(sf: ts.SourceFile, modulos: Set<string>, nomes: Set<string>): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (!modulos.has(st.moduleSpecifier.text)) continue;
    const vinc = st.importClause?.namedBindings;
    if (!vinc || !ts.isNamedImports(vinc)) continue;
    for (const el of vinc.elements) {
      const original = (el.propertyName ?? el.name).text;
      if (nomes.has(original)) mapa.set(el.name.text, original);
    }
  }
  return mapa;
}

function temPropriedade(arg: ts.Expression | undefined, nome: string): boolean {
  return (
    arg !== undefined &&
    ts.isObjectLiteralExpression(arg) &&
    arg.properties.some(
      (p) =>
        (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
        ts.isIdentifier(p.name) &&
        p.name.text === nome,
    )
  );
}

function faltasDoArquivo(caminho: string): { semSinal: string[]; semFetch: string[] } {
  const fonte = readFileSync(caminho, "utf8");
  if (![...FUNCOES, ...FABRICAS].some((f) => fonte.includes(f))) return { semSinal: [], semFetch: [] };
  const sf = ts.createSourceFile(caminho, fonte, ts.ScriptTarget.Latest, true);
  const doSdk = importados(sf, new Set(["ai"]), FUNCOES);
  const fabricas = importados(sf, PACOTES_DE_FABRICA, FABRICAS);
  const semSinal: string[] = [];
  const semFetch: string[] = [];
  const onde = (n: ts.Node) =>
    `${relative(RAIZ, caminho)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const visitar = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const nome = n.expression.text;
      if (doSdk.has(nome) && !temPropriedade(n.arguments[0], "abortSignal")) {
        semSinal.push(`${onde(n)} ${doSdk.get(nome)}`);
      }
      if (fabricas.has(nome) && !temPropriedade(n.arguments[0], "fetch")) {
        semFetch.push(`${onde(n)} ${fabricas.get(nome)}`);
      }
    }
    ts.forEachChild(n, visitar);
  };
  visitar(sf);
  return { semSinal, semFetch };
}

describe("varredura — nenhuma chamada ao modelo sem teto", () => {
  const todos = DIRS.flatMap((d) => arquivos(join(RAIZ, d)));
  const faltas = todos.map(faltasDoArquivo);

  it("GUARDA DE VACUIDADE: a varredura acha as chamadas e as fábricas conhecidas", () => {
    const rel = (lista: string[]) => lista.map((c) => relative(RAIZ, c));
    const comChamada = rel(
      todos.filter((c) => importados(ts.createSourceFile(c, readFileSync(c, "utf8"), ts.ScriptTarget.Latest), new Set(["ai"]), FUNCOES).size > 0),
    );
    expect(comChamada).toContain("lib/agent-engine/edge/llm/run-model-call.ts");
    expect(comChamada).toContain("workers/ai-response-worker.ts");
    expect(comChamada).toContain("lib/ai/embed.ts");
    const comFabrica = rel(
      todos.filter((c) => importados(ts.createSourceFile(c, readFileSync(c, "utf8"), ts.ScriptTarget.Latest), PACOTES_DE_FABRICA, FABRICAS).size > 0),
    );
    expect(comFabrica).toContain("lib/agent-engine/edge/llm/providers.ts");
    expect(comFabrica).toContain("lib/ai/runtime/agent.ts");
    expect(comFabrica).toContain("lib/ai/gateway-binding.ts");
  });

  it("toda chamada a generateText/generateObject/streamText/streamObject/embed/embedMany passa abortSignal", () => {
    expect(
      faltas.flatMap((f) => f.semSinal),
      "Chamada ao modelo sem `abortSignal`: um provedor travado prende o turno e a fila. " +
        "Use `sinalDoTurno()` (turno) ou `sinalDeUmaChamada()` (embedding) de `lib/ai/tempo-da-chamada.ts`.",
    ).toEqual([]);
  });

  it("toda fábrica de provedor recebe `fetch` (o teto por requisição mora nele)", () => {
    expect(
      faltas.flatMap((f) => f.semFetch),
      "Fábrica de provedor sem `fetch`: a requisição sai sem o teto LLM_CALL_TIMEOUT_MS. " +
        "Use `fetchComTetoPorRequisicao()` de `lib/ai/tempo-da-chamada.ts`.",
    ).toEqual([]);
  });
});
