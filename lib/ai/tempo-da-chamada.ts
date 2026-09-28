/**
 * Tetos de tempo das chamadas ao modelo — DOIS knobs, duas perguntas:
 *
 * - `LLM_CALL_TIMEOUT_MS` (padrão 90 s) é o teto de UMA requisição HTTP ao
 *   provedor. Vai no `fetch` do provedor (`fetchComTetoPorRequisicao`), então
 *   vale para cada passo de um turno com várias etapas, e NÃO conta o tempo das
 *   ferramentas que rodam entre um passo e o outro.
 * - `LLM_TURN_TIMEOUT_MS` (padrão 300 s) é o teto do TURNO inteiro — todos os
 *   passos mais a execução das ferramentas. Vai como `abortSignal` do
 *   `generateText` (`sinalDoTurno`).
 *
 * Por que dois: com um sinal só de 90 s cobrindo o `generateText` inteiro, um
 * turno legítimo de quatro passos com uma busca de conhecimento no meio era
 * abortado no quarto passo, embora nenhuma requisição tivesse travado. E sem
 * teto nenhum, um provedor que aceita a conexão e não responde prendia o turno
 * para sempre: o worker ficava parado nesse evento, a fila atrás dele esperava,
 * e o dreno acabava devolvendo o evento como órfão — repetindo o turno.
 *
 * RELAÇÃO QUE NÃO PODE SE INVERTER: o teto do turno fica ABAIXO da janela de
 * visibilidade da fila (`QUEUE_VISIBILITY_TIMEOUT_MS`, padrão 600 s, em
 * `lib/agent-engine/env.ts`) e da janela de órfão do `event_log` (10 min, em
 * `lib/event-log/drain.ts`). Um turno que passasse da janela seria reclamado
 * por outro worker enquanto o primeiro ainda roda — resposta em dobro ao
 * cliente. `tetoDoTurnoAbaixoDaVisibilidade` corrige uma configuração que
 * inverta a relação, e `tests/unit/llm-chamada-tem-teto.test.ts` prende os
 * padrões.
 *
 * Módulo PURO (sem `@/lib/env`): roda nos dois processos — o app lê o valor
 * validado em `lib/env.ts`, o worker em `lib/agent-engine/env.ts`, e o seam
 * recebe o número pela config. O knob nunca derruba o boot: valor inválido
 * vale o padrão.
 */

export const LLM_CALL_TIMEOUT_MS_PADRAO = 90_000;
export const LLM_TURN_TIMEOUT_MS_PADRAO = 300_000;
/** Padrão de `QUEUE_VISIBILITY_TIMEOUT_MS` (`lib/agent-engine/env.ts`) — um teste prende os dois juntos. */
export const QUEUE_VISIBILITY_TIMEOUT_MS_PADRAO = 600_000;

function inteiroPositivo(bruto: string | number | null | undefined): number | null {
  const n = typeof bruto === "number" ? bruto : Number((bruto ?? "").toString().trim() || NaN);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Lê o knob por requisição: inteiro positivo, ou o padrão. Nunca lança. */
export function lerTimeoutDeLlm(bruto: string | number | null | undefined): number {
  return inteiroPositivo(bruto) ?? LLM_CALL_TIMEOUT_MS_PADRAO;
}

/** Lê o knob do turno: inteiro positivo, ou o padrão. Nunca lança. */
export function lerTetoDoTurno(bruto: string | number | null | undefined): number {
  return inteiroPositivo(bruto) ?? LLM_TURN_TIMEOUT_MS_PADRAO;
}

/** O teto por requisição em vigor neste processo, lido do ambiente. */
export function timeoutDeLlmDoAmbiente(): number {
  return lerTimeoutDeLlm(process.env.LLM_CALL_TIMEOUT_MS);
}

/** O teto do turno em vigor neste processo, lido do ambiente. */
export function tetoDoTurnoDoAmbiente(): number {
  return lerTetoDoTurno(process.env.LLM_TURN_TIMEOUT_MS);
}

/**
 * Mantém o teto do turno abaixo da janela de visibilidade da fila. Um turno
 * configurado para durar mais que a janela faria outro worker reclamar o job
 * enquanto este ainda responde; nesse caso o teto cai para 90% da janela.
 */
export function tetoDoTurnoAbaixoDaVisibilidade(
  tetoDoTurnoMs: number,
  visibilidadeMs: number | null | undefined,
): number {
  const janela = inteiroPositivo(visibilidadeMs ?? null);
  if (janela === null || tetoDoTurnoMs < janela) return tetoDoTurnoMs;
  return Math.max(1_000, Math.floor(janela * 0.9));
}

/**
 * Envolve o `fetch` de um provedor de modelo com o teto POR REQUISIÇÃO: cada
 * chamada HTTP ganha o próprio `AbortSignal.timeout`, combinado com o sinal que
 * o SDK já passa (o do turno). O teto cobre a requisição até o corpo terminar
 * de chegar — num `streamText`, o stream inteiro daquele passo.
 *
 * O `fetch` interno padrão é resolvido na HORA da chamada (`globalThis.fetch`),
 * e não na criação: é o que os testes substituem.
 */
export function fetchComTetoPorRequisicao(
  interno?: typeof fetch,
  timeoutMs: number = timeoutDeLlmDoAmbiente(),
): typeof fetch {
  const teto = lerTimeoutDeLlm(timeoutMs);
  return (input, init) => {
    const sinalDoTeto = AbortSignal.timeout(teto);
    const signal = init?.signal ? AbortSignal.any([init.signal, sinalDoTeto]) : sinalDoTeto;
    return (interno ?? globalThis.fetch)(input, { ...init, signal });
  };
}

/**
 * O sinal a passar como `abortSignal` a `generateText`/`generateObject`: o teto
 * do TURNO inteiro, OU o sinal de quem chamou — o que vier primeiro. O teto de
 * cada requisição mora no `fetch` do provedor (`fetchComTetoPorRequisicao`).
 */
export function sinalDoTurno(
  timeoutMs: number = tetoDoTurnoDoAmbiente(),
  externo?: AbortSignal | null,
): AbortSignal {
  const teto = AbortSignal.timeout(lerTetoDoTurno(timeoutMs));
  return externo ? AbortSignal.any([externo, teto]) : teto;
}

/**
 * O sinal de uma chamada que é UMA requisição só — embedding, sobretudo (o
 * `embed()` do SDK faz uma requisição, mais as retentativas). Teto
 * `LLM_CALL_TIMEOUT_MS`, OU o sinal de quem chamou.
 */
export function sinalDeUmaChamada(
  timeoutMs: number = timeoutDeLlmDoAmbiente(),
  externo?: AbortSignal | null,
): AbortSignal {
  const teto = AbortSignal.timeout(lerTimeoutDeLlm(timeoutMs));
  return externo ? AbortSignal.any([externo, teto]) : teto;
}
