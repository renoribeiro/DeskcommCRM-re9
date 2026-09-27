/**
 * W4 — CSP que não quebra o Next, e HSTS decidido pela instalação em runtime.
 */
import { describe, expect, it, vi } from "vitest";

import {
  CONTENT_SECURITY_POLICY,
  hstsDaInstalacao,
} from "@/lib/http/cabecalhos-de-seguranca";

vi.mock("@sentry/nextjs/config", () => ({
  withSentryConfig: (config: unknown) => config,
}));

describe("Content-Security-Policy da aplicação", () => {
  it("fecha clickjacking, <base>, plugins e formulário para fora", () => {
    const diretivas = CONTENT_SECURITY_POLICY.split(";").map((d) => d.trim());
    expect(diretivas).toEqual(
      expect.arrayContaining([
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "object-src 'none'",
        "form-action 'self'",
      ]),
    );
  });

  it("não restringe script nem estilo (quebraria a hidratação do Next sem nonce)", () => {
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/(^|;)\s*(default-src|script-src|style-src)\b/);
  });

  it("o next.config.ts manda a CSP em toda rota", async () => {
    const { default: config } = await import("../../next.config");
    const regras = await config.headers!();
    const todas = regras.find((r) => r.source === "/(.*)");
    const csp = todas?.headers.find((h) => h.key === "Content-Security-Policy");
    expect(csp?.value).toBe(CONTENT_SECURITY_POLICY);
    // HSTS decidido no build seria decidido pela URL placeholder da imagem.
    expect(todas?.headers.some((h) => h.key === "Strict-Transport-Security")).toBe(false);
  });
});

describe("HSTS por instalação", () => {
  it("só quando a instalação declara https", () => {
    expect(hstsDaInstalacao("https://crm.cliente.com.br")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(hstsDaInstalacao("HTTPS://crm.cliente.com.br")).not.toBeNull();
    expect(hstsDaInstalacao("http://203.0.113.5:3000")).toBeNull();
    expect(hstsDaInstalacao("")).toBeNull();
    expect(hstsDaInstalacao(undefined)).toBeNull();
  });
});
