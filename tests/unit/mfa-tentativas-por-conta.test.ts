/**
 * P6 — o limite de tentativas do código TOTP é da CONTA, não do cookie.
 *
 * O contador vivia só no cookie `mfa_attempts`, que o próprio navegador apaga.
 * Aqui o "atacante" chega sempre SEM o cookie (um store novo a cada chamada) e
 * de IPs diferentes: o bloqueio tem de vir do contador da conta.
 *
 * O contador é o real (`lib/ai/dispatcher/rate-limit.ts`), na memória do
 * processo — o caminho do CI, onde não há UPSTASH.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cookies, headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";

vi.mock("next/headers", () => ({ headers: vi.fn(), cookies: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  audit: vi.fn(async () => undefined),
}));

const verificar = vi.fn(async () => ({ error: new Error("Invalid TOTP code") }));
let userId = "";
let ip = 0;

beforeEach(() => {
  userId = `u-${Math.random().toString(36).slice(2)}`;
  verificar.mockClear();
  vi.mocked(headers).mockImplementation(
    async () => ({ get: (k: string) => (k === "x-forwarded-for" ? `203.0.113.${(ip++ % 200) + 1}` : null) }) as never,
  );
  // Cookie sempre vazio: quem ataca apaga o `mfa_attempts` a cada tentativa.
  vi.mocked(cookies).mockImplementation(
    async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn() }) as never,
  );
  vi.mocked(createClient).mockImplementation(
    async () =>
      ({
        auth: {
          getUser: async () => ({ data: { user: { id: userId } } }),
          mfa: {
            listFactors: async () => ({ data: { totp: [{ id: "f1", status: "verified" }] } }),
            challenge: async () => ({ data: { id: "c1" }, error: null }),
            verify: verificar,
          },
        },
      }) as never,
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("verifyMfa — tentativas contadas por conta", () => {
  it("3 códigos errados trancam a conta mesmo sem o cookie", async () => {
    const { verifyMfa } = await import("@/app/actions/auth/verifyMfa");
    expect(await verifyMfa("111111")).toEqual({ ok: false, error: "mfa_invalid" });
    expect(await verifyMfa("222222")).toEqual({ ok: false, error: "mfa_invalid" });
    const terceira = await verifyMfa("333333");
    expect(terceira).toMatchObject({ ok: false, error: "mfa_locked" });

    const quarta = await verifyMfa("444444");
    expect(quarta).toMatchObject({ ok: false, error: "mfa_locked" });
    // O quarto chute NEM chega ao GoTrue.
    expect(verificar).toHaveBeenCalledTimes(3);
  });

  it("esperar a janela curta não zera: 10 falhas na hora trancam por 1 h", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-27T10:00:00Z"));
    const { verifyMfa } = await import("@/app/actions/auth/verifyMfa");

    let ultima: unknown;
    for (let lote = 0; lote < 4; lote++) {
      for (let i = 0; i < 3 && verificar.mock.calls.length < 10; i++) {
        ultima = await verifyMfa("000000");
      }
      vi.setSystemTime(Date.now() + 61_000);
    }
    expect(verificar).toHaveBeenCalledTimes(10);
    expect(ultima).toMatchObject({ error: "mfa_locked", retry_in_seconds: 3600 });

    const depois = await verifyMfa("123456");
    expect(depois).toMatchObject({ error: "mfa_locked", retry_in_seconds: 3600 });
    expect(verificar).toHaveBeenCalledTimes(10);
  });

  it("outra conta não herda o bloqueio", async () => {
    const { verifyMfa } = await import("@/app/actions/auth/verifyMfa");
    for (let i = 0; i < 3; i++) await verifyMfa("999999");
    userId = `outra-${userId}`;
    expect(await verifyMfa("999999")).toEqual({ ok: false, error: "mfa_invalid" });
  });
});
