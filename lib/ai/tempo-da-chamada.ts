/**
 * Teto de tempo de UMA chamada ao modelo (knob `LLM_CALL_TIMEOUT_MS`).
 *
 * Sem teto, um provedor que aceita a conexão e não responde prendia o turno
 * para sempre: o worker ficava parado nesse evento, a fila atrás dele esperava,
 * e o dreno acabava devolvendo o evento como órfão — repetindo o turno, com o
 * risco de a primeira resposta ainda chegar. Com o teto, a chamada é abortada,
 * o erro é gravado como qualquer falha do provedor e quem chamou decide.
 *
 * Módulo PURO (sem `@/lib/env`): roda nos dois processos — o app lê o valor
 * validado em `lib/env.ts`, o worker em `lib/agent-engine/env.ts`, e o seam
 * recebe o número pela config. O knob nunca derruba o boot: valor inválido
 * vale o padrão.
 */

export const LLM_CALL_TIMEOUT_MS_PADRAO = 90_000;

/** Lê o knob: inteiro positivo, ou o padrão. Nunca lança. */
export function lerTimeoutDeLlm(bruto: string | number | null | undefined): number {
  const n = typeof bruto === "number" ? bruto : Number((bruto ?? "").toString().trim() || NaN);
  return Number.isInteger(n) && n > 0 ? n : LLM_CALL_TIMEOUT_MS_PADRAO;
}

/** O teto em vigor neste processo, lido do ambiente. */
export function timeoutDeLlmDoAmbiente(): number {
  return lerTimeoutDeLlm(process.env.LLM_CALL_TIMEOUT_MS);
}

/**
 * O sinal a passar como `abortSignal` a `generateText`/`generateObject`: dispara
 * no teto OU quando o sinal de quem chamou disparar — o que vier primeiro.
 */
export function sinalDaChamadaAoModelo(
  timeoutMs: number = timeoutDeLlmDoAmbiente(),
  externo?: AbortSignal | null,
): AbortSignal {
  const teto = AbortSignal.timeout(lerTimeoutDeLlm(timeoutMs));
  return externo ? AbortSignal.any([externo, teto]) : teto;
}
