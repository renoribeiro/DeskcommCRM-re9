/**
 * Cabeçalhos para servir, NA ORIGEM DO APP, bytes que vieram de fora.
 *
 * Auditoria P3 (`docs/imobiliario/04-auditoria-seguranca-e-qualidade.md`): a
 * mídia recebida saía com o `Content-Type` que o REMETENTE declarou. Um `.html`
 * (ou SVG com `<script>`) mandado pelo WhatsApp, aberto pelo atendente, rodava
 * script no domínio do CRM — com o cookie de sessão dele.
 *
 * A régua tem três partes, e nenhuma basta sozinha:
 *  1. lista FECHADA do que o navegador pode exibir no lugar (imagem raster,
 *     áudio, vídeo, PDF). O resto vira `attachment` e `application/octet-stream`;
 *  2. `X-Content-Type-Options: nosniff`, para o navegador não "descobrir" HTML
 *     dentro de um tipo inofensivo;
 *  3. `Content-Security-Policy: sandbox; default-src 'none'` — mesmo que algo
 *     escape das duas primeiras, o documento nasce numa origem opaca, sem script.
 *
 * ⚠️ PDF é exibível na URL ASSINADA do Storage (outra origem, sem estes
 * cabeçalhos), mas NÃO nos bytes servidos aqui: o visualizador de PDF do Chrome
 * se recusa a abrir documento sob `sandbox`, e o atendente veria uma página em
 * branco. Neste caminho — só o intervalo antes de a mídia ser persistida — o
 * PDF sai como download (`podeExibirNaOrigemDoApp`).
 */

const EXIBIVEIS_EXATOS = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
]);

function tipoBase(mime: string | null | undefined): string {
  return (mime ?? "").split(";")[0]!.trim().toLowerCase();
}

/** Imagem raster, PDF, `audio/*` e `video/*`. Todo o resto é download. */
export function podeExibirNoNavegador(mime: string | null | undefined): boolean {
  const base = tipoBase(mime);
  if (EXIBIVEIS_EXATOS.has(base)) return true;
  return /^(audio|video)\/[a-z0-9.+-]+$/.test(base);
}

/**
 * O que pode sair `inline` NOS BYTES SERVIDOS PELA ORIGEM DO APP (sob `sandbox`):
 * a mesma lista, menos PDF — ver o aviso do cabeçalho.
 */
export function podeExibirNaOrigemDoApp(mime: string | null | undefined): boolean {
  return tipoBase(mime) !== "application/pdf" && podeExibirNoNavegador(mime);
}

export const CSP_DE_BYTES_DE_FORA = "sandbox; default-src 'none'";

/**
 * Cabeçalhos para um corpo de bytes vindos do cliente ou do canal. O
 * `Content-Type` só é repassado (reduzido ao tipo base) quando está na lista; o
 * que não está vira `application/octet-stream` + `attachment` — o navegador
 * baixa, não interpreta.
 */
export function cabecalhosDeBytesDeFora(
  mime: string | null | undefined,
): Record<string, string> {
  const exibivel = podeExibirNaOrigemDoApp(mime);
  return {
    "Content-Type": exibivel ? tipoBase(mime) : "application/octet-stream",
    "Content-Disposition": exibivel ? "inline" : "attachment",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": CSP_DE_BYTES_DE_FORA,
  };
}
