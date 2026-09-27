/**
 * O que o arquivo É, pelos bytes — para o upload de mídia de saída (W7).
 *
 * O `file.type` do multipart é do cliente: um `.html` ou `.svg` declarado como
 * `image/png` (ou `image/svg+xml` aceito pelo prefixo `image/`) ia para o
 * bucket e de lá para o WhatsApp de outra pessoa, e para a própria tela do CRM
 * quando alguém abre a mídia. Aqui a família é decidida pela ASSINATURA, e a
 * declaração só é aceita se bater com ela.
 *
 * O `farejarTipo` do logo (`lib/branding/logo-arquivo.ts`) é o mesmo princípio,
 * mas aceita só PNG/JPEG; mídia de conversa precisa de áudio, vídeo e
 * documento. O detector de marcação (`pareceSvg`) é reaproveitado de lá.
 *
 * Lista FECHADA: o que não é reconhecido não entra. Não reconhecer e reconhecer
 * algo proibido levam ao mesmo 415.
 */
import { pareceSvg } from "@/lib/branding/logo-arquivo";

export type FamiliaFarejada =
  | "image"
  | "video"
  | "audio"
  /** Contêiner que carrega áudio OU vídeo (MP4/ISO-BMFF, WebM/Matroska, 3GP). */
  | "audiovisual"
  | "pdf"
  /** Documento Office legado (doc/xls/ppt) — Compound File Binary. */
  | "ole"
  /** ZIP, inclusive docx/xlsx/pptx. */
  | "zip"
  | "text";

const JANELA = 1024;

function comecaCom(b: Uint8Array, assinatura: number[], deslocamento = 0): boolean {
  if (b.length < deslocamento + assinatura.length) return false;
  return assinatura.every((v, i) => b[deslocamento + i] === v);
}

function ascii(b: Uint8Array, inicio: number, fim: number): string {
  let s = "";
  for (let i = inicio; i < Math.min(fim, b.length); i++) s += String.fromCharCode(b[i]!);
  return s;
}

/**
 * Parece marcação que um navegador executaria (HTML, SVG, XML)?
 * Frouxo de propósito — o erro caro é o falso negativo.
 */
export function pareceMarcacao(bytes: Uint8Array): boolean {
  if (pareceSvg(bytes)) return true;
  const texto = ascii(bytes, 0, JANELA);
  return /<\s*(!doctype\s+html|html|head|body|script|iframe|object|embed|meta|svg|xml)[\s>/]/i.test(
    texto,
  );
}

const MARCAS_DE_IMAGEM_ISO = new Set(["heic", "heix", "hevc", "hevx", "mif1", "msf1", "avif", "avis"]);

/** A família do arquivo pelos bytes, ou `null` quando não reconhecida. */
export function farejarMidia(bytes: Uint8Array): FamiliaFarejada | null {
  // Imagem
  if (comecaCom(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image"; // PNG
  if (comecaCom(bytes, [0xff, 0xd8, 0xff])) return "image"; // JPEG
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image";

  // Contêineres ISO-BMFF (`....ftyp<marca>`): MP4, MOV, M4A, 3GP, HEIC, AVIF.
  if (ascii(bytes, 4, 8) === "ftyp") {
    const marca = ascii(bytes, 8, 12).toLowerCase();
    if (MARCAS_DE_IMAGEM_ISO.has(marca)) return "image";
    if (marca.startsWith("m4a") || marca.startsWith("m4b")) return "audio";
    return "audiovisual";
  }
  if (comecaCom(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "audiovisual"; // WebM/Matroska

  // Áudio
  if (ascii(bytes, 0, 4) === "OggS") return "audio";
  if (ascii(bytes, 0, 3) === "ID3") return "audio"; // MP3 com tag
  if (bytes.length > 1 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return "audio"; // MPEG/AAC ADTS
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE") return "audio";
  if (ascii(bytes, 0, 5) === "#!AMR") return "audio";
  if (ascii(bytes, 0, 4) === "fLaC") return "audio";

  // Documentos
  if (ascii(bytes, 0, 5) === "%PDF-") return "pdf";
  if (comecaCom(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "ole";
  if (comecaCom(bytes, [0x50, 0x4b, 0x03, 0x04]) || comecaCom(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    return "zip";
  }

  // Texto puro: sem byte nulo nem controle binário na janela, e sem marcação.
  if (bytes.length > 0 && !pareceMarcacao(bytes)) {
    const janela = bytes.subarray(0, JANELA);
    const binario = janela.some((b) => b === 0 || (b < 0x09) || (b > 0x0d && b < 0x20 && b !== 0x1b));
    if (!binario) return "text";
  }
  return null;
}

/** Que famílias farejadas satisfazem cada mime declarado. */
function familiasAceitas(mimeBase: string): FamiliaFarejada[] {
  if (mimeBase === "image/svg+xml") return [];
  if (mimeBase.startsWith("image/")) return ["image"];
  if (mimeBase.startsWith("video/") || mimeBase === "application/mp4") return ["audiovisual"];
  if (mimeBase.startsWith("audio/")) return ["audio", "audiovisual"];
  switch (mimeBase) {
    case "application/pdf":
      return ["pdf"];
    case "application/msword":
    case "application/vnd.ms-excel":
    case "application/vnd.ms-powerpoint":
      return ["ole"];
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    case "application/zip":
      return ["zip"];
    case "text/plain":
    case "text/csv":
      return ["text"];
    default:
      return [];
  }
}

/**
 * O conteúdo bate com o mime declarado? `false` para marcação (SVG/HTML/XML)
 * em qualquer declaração, para conteúdo não reconhecido e para família trocada
 * (ex.: HTML declarado `image/png`, PDF declarado `audio/ogg`).
 */
export function conteudoBateComMime(mime: string, bytes: Uint8Array): boolean {
  // A marcação é excluída DENTRO do farejador, no ramo de texto — que é onde ela
  // pode estar. Um binário com assinatura válida (JPEG, PDF, docx) pode trazer
  // `<?xml` nos metadados (XMP) sem ser marcação, e recusá-lo por isso seria
  // falso positivo; servido com o próprio tipo e `nosniff`, ele não executa.
  const base = mime.split(";")[0]!.trim().toLowerCase();
  const familia = farejarMidia(bytes);
  if (!familia) return false;
  return familiasAceitas(base).includes(familia);
}
