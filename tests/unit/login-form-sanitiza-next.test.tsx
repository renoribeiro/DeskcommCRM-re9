/**
 * W11 — o `LoginForm` não leva quem acabou de entrar para fora da instalação
 * por um `?next=` forjado. O servidor já sanitizava o dele; o formulário usava
 * o valor cru para montar o destino do passo de MFA e o fallback do redirect.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
const entrar = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/app/actions/auth/signInWithPassword", () => ({
  signInWithPassword: (...args: unknown[]) => entrar(...args),
}));

import { LoginForm } from "@/components/auth/LoginForm";

async function submeter(next: string) {
  render(<LoginForm next={next} />);
  fireEvent.change(screen.getByLabelText(/e-?mail/i), { target: { value: "ana@exemplo.test" } });
  fireEvent.change(screen.getByLabelText(/senha/i), { target: { value: "SenhaForte!2026" } });
  fireEvent.submit(screen.getByLabelText(/senha/i).closest("form")!);
  await waitFor(() => expect(replace).toHaveBeenCalled());
  return String(replace.mock.calls[0]![0]);
}

beforeEach(() => {
  replace.mockReset();
  entrar.mockReset();
});
afterEach(cleanup);

describe("LoginForm — destino depois de entrar", () => {
  it("passo de MFA não carrega next externo", async () => {
    entrar.mockResolvedValue({ ok: false, error: "mfa_required" });
    const destino = await submeter("//phishing.exemplo/app");
    expect(destino.startsWith("/login/mfa")).toBe(true);
    expect(destino).not.toContain("phishing");
  });

  it("fallback sem resposta não sai do site", async () => {
    entrar.mockResolvedValue(undefined);
    expect(await submeter("https://phishing.exemplo")).toBe("/app");
  });

  it("next interno segue preservado", async () => {
    entrar.mockResolvedValue({ ok: false, error: "mfa_required" });
    const destino = await submeter("/app/inbox");
    expect(new URL(destino, "https://x").searchParams.get("next")).toBe("/app/inbox");
  });
});
