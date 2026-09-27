/**
 * W9 — o link que vai no e-mail de redefinição de senha e de confirmação de
 * cadastro aponta para a URL da INSTALAÇÃO, nunca para o cabeçalho `Origin`
 * que veio na requisição (que quem faz a requisição escolhe).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/politica-de-cadastro", () => ({
  modoDeCadastro: vi.fn(async () => "aberto"),
}));
vi.mock("@/lib/audit", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  audit: vi.fn(async () => undefined),
}));

const ORIGEM_FORJADA = "https://phishing.exemplo";
const reset = vi.fn(async () => ({ error: null }));
const cadastro = vi.fn(async () => ({
  data: { user: { id: "u1", identities: [{ id: "i" }] }, session: null },
  error: null,
}));

let n = 0;
beforeEach(() => {
  n += 1;
  reset.mockClear();
  cadastro.mockClear();
  vi.mocked(headers).mockResolvedValue({
    get: (k: string) =>
      k === "origin" ? ORIGEM_FORJADA : k === "x-forwarded-for" ? `198.51.100.${(n % 200) + 20}` : null,
  } as never);
  vi.mocked(createClient).mockResolvedValue({
    auth: { resetPasswordForEmail: reset, signUp: cadastro },
  } as never);
});

const base = () => env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");

describe("redirectTo dos e-mails de autenticação", () => {
  it("reset de senha ignora o Origin e usa NEXT_PUBLIC_APP_URL", async () => {
    const { requestPasswordReset } = await import("@/app/actions/auth/requestPasswordReset");
    await requestPasswordReset({ email: `w9-${n}-${Date.now()}@exemplo.test` });
    expect(reset).toHaveBeenCalledTimes(1);
    const opcoes = (reset.mock.calls[0] as unknown as [string, { redirectTo: string }])[1];
    expect(opcoes.redirectTo).toBe(`${base()}/auth/confirm?type=recovery`);
    expect(opcoes.redirectTo).not.toContain("phishing");
  });

  it("cadastro ignora o Origin e usa NEXT_PUBLIC_APP_URL", async () => {
    const { signUp } = await import("@/app/actions/auth/signUp");
    await signUp({
      org_name: "Org W9",
      email: `w9-cad-${n}-${Date.now()}@exemplo.test`,
      password: "SenhaForte!2026",
      password_confirm: "SenhaForte!2026",
    } as never);
    expect(cadastro).toHaveBeenCalledTimes(1);
    const arg = (cadastro.mock.calls[0] as unknown as [{ options: { emailRedirectTo: string } }])[0];
    expect(arg.options.emailRedirectTo).toBe(`${base()}/auth/confirm?type=signup`);
    expect(arg.options.emailRedirectTo).not.toContain("phishing");
  });
});
