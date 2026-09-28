/**
 * G2 — o `gpt-tokenizer` (~1 MB gzip) sai do bundle inicial do editor de agente.
 *
 * Duas provas: (1) a FONTE não importa o pacote estaticamente — um `import`
 * no topo é o que o bundler põe no chunk inicial; (2) o comportamento segue o
 * mesmo para quem lê a etiqueta: há um número desde a primeira contagem (a
 * estimativa) e ele vira o exato quando o tokenizador chega.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const portao = vi.hoisted(() => {
  let liberar: () => void = () => {};
  const pronto = new Promise<void>((r) => {
    liberar = r;
  });
  return { pronto, liberar: () => liberar() };
});

// O tokenizador "de verdade" desta suíte: 1 token por palavra, e só chega
// quando o teste libera — é o intervalo em que a estimativa tem de aparecer.
vi.mock("gpt-tokenizer", async () => {
  await portao.pronto;
  return { encode: (t: string) => t.split(/\s+/).filter(Boolean).map(() => 0) };
});

import { TokenCounter } from "./TokenCounter";

afterEach(() => {
  vi.useRealTimers();
});

describe("TokenCounter — tokenizador sob demanda", () => {
  it("a fonte não importa gpt-tokenizer estaticamente", () => {
    const fonte = readFileSync(join(__dirname, "TokenCounter.tsx"), "utf8");
    expect(fonte).not.toMatch(/^\s*import[^;]*from\s+["']gpt-tokenizer["']/m);
    expect(fonte).toMatch(/import\(\s*["']gpt-tokenizer["']\s*\)/);
  });

  it("mostra a estimativa enquanto carrega e o número exato quando chega", async () => {
    vi.useFakeTimers();
    const texto = "um dois tres quatro cinco seis sete oito nove dez"; // 50 chars, 10 palavras
    render(<TokenCounter text={texto} />);
    expect(screen.getByText(/— tokens/)).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    // estimativa: ceil(50 / 4) = 13
    expect(screen.getByText(/~13 tokens/)).toBeTruthy();

    vi.useRealTimers();
    await act(async () => {
      portao.liberar();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByText(/~10 tokens/)).toBeTruthy();
  });
});
