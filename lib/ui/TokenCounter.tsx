"use client";
import * as React from "react";

/**
 * Contador de tokens do editor de agente.
 *
 * O `gpt-tokenizer` pesa ~1 MB gzip (tabelas BPE inteiras). Importado no topo,
 * ele entrava no bundle INICIAL do editor de agente só para esta etiqueta.
 * Agora é carregado sob demanda, na primeira contagem, e fica em cache no
 * módulo. Enquanto carrega, a etiqueta mostra uma estimativa por caracteres
 * (≈4 por token) — nunca fica em branco, e troca pelo número exato quando o
 * tokenizador chega.
 */

type Encode = (texto: string) => number[];

let tokenizador: Encode | null = null;
let carregando: Promise<Encode> | null = null;

/** Carrega o tokenizador uma vez por página. Exportado para teste. */
export function carregarTokenizador(): Promise<Encode> {
  if (tokenizador) return Promise.resolve(tokenizador);
  carregando ??= import("gpt-tokenizer").then((m) => {
    tokenizador = m.encode;
    return m.encode;
  });
  carregando.catch(() => {
    // Falhou (rede, chunk ausente): a próxima contagem tenta de novo.
    carregando = null;
  });
  return carregando;
}

/** Estimativa barata enquanto o tokenizador não chegou: ~4 caracteres por token. */
export function estimarTokens(texto: string): number {
  return Math.ceil((texto ?? "").length / 4);
}

interface Props {
  text: string;
  contextWindow?: number | null;
  className?: string;
}

export function TokenCounter({ text, contextWindow, className }: Props) {
  const [count, setCount] = React.useState<number | null>(null);

  React.useEffect(() => {
    let vivo = true;
    const t = setTimeout(() => {
      const texto = text ?? "";
      if (tokenizador) {
        try {
          setCount(tokenizador(texto).length);
        } catch {
          setCount(null);
        }
        return;
      }
      setCount(estimarTokens(texto));
      carregarTokenizador()
        .then((encode) => {
          if (vivo) setCount(encode(texto).length);
        })
        .catch(() => {
          // Fica a estimativa: melhor que nada, e o próximo texto tenta de novo.
        });
    }, 200);
    return () => {
      vivo = false;
      clearTimeout(t);
    };
  }, [text]);

  if (count === null) {
    return (
      <span className={className} aria-live="polite">
        — tokens
      </span>
    );
  }

  const ratio = contextWindow && contextWindow > 0 ? count / contextWindow : null;
  const warn = ratio !== null && ratio > 0.8;
  const danger = ratio !== null && ratio > 1;

  const tone = danger
    ? "text-destructive"
    : warn
      ? "text-amber-600 dark:text-amber-400"
      : "text-muted-foreground";

  return (
    <span className={`${tone} ${className ?? ""}`} aria-live="polite">
      ~{count.toLocaleString("pt-BR")} tokens
      {contextWindow ? ` / ${contextWindow.toLocaleString("pt-BR")}` : ""}
      {warn && !danger ? " · próximo do limite" : ""}
      {danger ? " · acima do limite" : ""}
    </span>
  );
}
