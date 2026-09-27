/**
 * MediaSource do WAHA: baixa o binário hospedado pelo container WAHA.
 *
 * A URL anunciada no webhook NÃO é confiável nem correta: o HMAC é
 * best-effort (payload forjado é possível) e o WAHA anuncia seu endereço
 * INTERNO (ex.: localhost:3000 dentro do container, mapeado p/ 3030 no
 * host). Por isso o fetch é SEMPRE reconstruído sobre WAHA_API_BASE_URL,
 * aproveitando apenas o CAMINHO DE ARQUIVO da URL anunciada — SSRF impossível
 * por construção (o host nunca vem do payload) e, desde a auditoria P1, nenhum
 * outro endpoint da API do WAHA alcançável (ver `caminhoDeArquivoDoWaha`). A futura MetaMediaSource
 * implementa a mesma assinatura baixando via media_id + Graph API.
 */
import {
  MAX_MEDIA_BYTES,
  MediaTooLargeError,
  type FetchedMedia,
} from "@/lib/messaging/media/types";

const FETCH_TIMEOUT_MS = 30_000;

/**
 * O ÚNICO prefixo que o WAHA usa para servir anexo recebido
 * (`http://localhost:3000/api/files/<sessão>/<arquivo>`, medido no WAHA
 * 2026.7.x NOWEB — ver `tests/unit/waha-ingest-media.test.ts`).
 */
const PREFIXO_DE_ARQUIVO = "/api/files/";

/** Segmento de caminho aceitável: sem `%`, sem barra invertida, sem `..`. */
const SEGMENTO = /^[A-Za-z0-9_@.:+=-]{1,200}$/;

/**
 * Trocar só o host NÃO bastava (auditoria P1, `docs/imobiliario/04-…`).
 *
 * A API key do WAHA é da INSTALAÇÃO: ela lê sessões, conversas e contatos de
 * TODAS as organizações. Com o host reconstruído mas o caminho livre, uma
 * `media_url` gravada na linha (`…/api/sessions`, `…/api/<sessão-de-outra-org>/
 * chats`) virava proxy autenticado para qualquer endpoint dela. Agora só
 * sobrevive um caminho de arquivo — `/api/files/…` —, sem query, sem `..`, sem
 * `%` (que o servidor decodificaria depois desta conferência) e, quando o
 * caminho traz a sessão, a sessão tem de ser a da conexão desta mensagem.
 *
 * Devolve o caminho a buscar, ou `null` quando a URL não é um arquivo do WAHA.
 */
export function caminhoDeArquivoDoWaha(
  mediaUrl: string,
  sessionRef?: string | null,
): string | null {
  // Conferência sobre o texto CRU: `new URL` resolve `..` antes de nós
  // olharmos, e `/api/files/../sessions` viraria `/api/sessions` — recusado
  // pelo prefixo, mas o `..` cru é sinal de ataque e não há razão para aceitar.
  if (/\\|%|\.\.|[\u0000-\u001f\u007f]/.test(mediaUrl)) return null;
  let advertised: URL;
  try {
    advertised = new URL(mediaUrl);
  } catch {
    return null;
  }
  if (advertised.protocol !== "http:" && advertised.protocol !== "https:") return null;
  const { pathname } = advertised;
  if (!pathname.startsWith(PREFIXO_DE_ARQUIVO)) return null;
  const segmentos = pathname.slice(PREFIXO_DE_ARQUIVO.length).split("/");
  if (segmentos.length < 1 || segmentos.length > 2) return null;
  if (!segmentos.every((seg) => SEGMENTO.test(seg) && seg !== "." && seg !== "..")) return null;
  // `/api/files/<sessão>/<arquivo>`: a sessão do caminho é a desta conexão.
  // Sem isso, o anexo de outra organização (outra sessão no MESMO WAHA)
  // seria servido a quem conhecesse o nome do arquivo.
  if (segmentos.length === 2 && sessionRef && segmentos[0] !== sessionRef) return null;
  return pathname;
}

export async function fetchWahaMedia(
  mediaUrl: string,
  hintMime?: string | null,
  sessionRef?: string | null,
): Promise<FetchedMedia> {
  const base = process.env.WAHA_API_BASE_URL;
  const caminho = caminhoDeArquivoDoWaha(mediaUrl, sessionRef);
  if (!caminho) throw new Error("waha_media_untrusted_host");
  let url: URL;
  try {
    // Host/porta/query descartados: só o caminho de arquivo sobrevive, na base.
    url = new URL(caminho, base ?? "");
  } catch {
    throw new Error("waha_media_untrusted_host");
  }

  const apiKey = process.env.WAHA_API_KEY;
  const res = await fetch(url.toString(), {
    headers: apiKey ? { "X-Api-Key": apiKey } : {},
    // Redirect seguido levaria a X-Api-Key para onde o WAHA (ou quem se passar
    // por ele) mandar. Arquivo do WAHA não redireciona.
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`waha_media_${res.status}`);

  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_MEDIA_BYTES) throw new MediaTooLargeError();

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > MAX_MEDIA_BYTES) throw new MediaTooLargeError();

  const mime = res.headers.get("content-type") || hintMime || "application/octet-stream";
  return { buffer, mime };
}
