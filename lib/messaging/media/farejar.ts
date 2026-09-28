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

const MARCACAO =
  /<\s*(!doctype\s+(html|svg)|html|head|body|script|iframe|object|embed|meta|svg|xml)[\s>/]|<\?xml/i;

/**
 * Texto em UTF-16 com BOM (o "Unicode" do Bloco de Notas e do "Salvar como
 * texto Unicode" do Excel): a janela decodificada, ou `null` quando não há BOM
 * ou a sequência não é UTF-16 válida (surrogate solto — o que um binário que
 * por acaso começa com FF FE produz logo nos primeiros bytes).
 *
 * Sem isto, todo CSV/TXT UTF-16 era "binário" (metade dos bytes é nula) e o
 * FF FE do BOM ainda casava com a sincronia de quadro MPEG — virava "áudio".
 */
function textoUtf16(bytes: Uint8Array): string | null {
  let codificacao: "utf-16le" | "utf-16be";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) codificacao = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) codificacao = "utf-16be";
  else return null;
  let fim = Math.min(bytes.length, JANELA);
  fim -= fim % 2;
  if (fim < 4) return null;
  // A janela pode cortar um par de surrogates ao meio; a unidade alta solta no
  // FIM é artefato do corte, não defeito do arquivo.
  const ultimaAlta = codificacao === "utf-16le" ? bytes[fim - 1]! : bytes[fim - 2]!;
  if (ultimaAlta >= 0xd8 && ultimaAlta <= 0xdb) fim -= 2;
  try {
    return new TextDecoder(codificacao, { fatal: true }).decode(bytes.subarray(2, fim));
  } catch {
    return null;
  }
}

/**
 * Parece marcação que um navegador executaria (HTML, SVG, XML)?
 * Frouxo de propósito — o erro caro é o falso negativo. Olha a janela como
 * bytes (latin1) E, quando há BOM de UTF-16, decodificada — `<\0s\0v\0g\0`
 * não casa com nenhuma regex em latin1.
 */
export function pareceMarcacao(bytes: Uint8Array): boolean {
  if (pareceSvg(bytes)) return true;
  if (MARCACAO.test(ascii(bytes, 0, JANELA))) return true;
  const utf16 = textoUtf16(bytes);
  return utf16 !== null && MARCACAO.test(utf16);
}

/** Caractere de controle que texto não tem (TAB, LF, VT, FF, CR e ESC têm). */
function temControleBinario(codigos: Iterable<number>): boolean {
  for (const c of codigos) {
    if (c === 0 || c < 0x09 || (c > 0x0d && c < 0x20 && c !== 0x1b)) return true;
  }
  return false;
}

/**
 * BMP: "BM" sozinho são dois bytes que um CSV ("BMW;…") também tem. Exige-se o
 * cabeçalho coerente: os 4 bytes reservados (6..9) nulos e o tamanho do
 * cabeçalho DIB (offset 14) num dos valores que o formato define.
 */
function pareceBmp(bytes: Uint8Array): boolean {
  if (bytes.length < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return false;
  if (bytes[6] !== 0 || bytes[7] !== 0 || bytes[8] !== 0 || bytes[9] !== 0) return false;
  const dib = bytes[14]! | (bytes[15]! << 8) | (bytes[16]! << 16) | (bytes[17]! << 24);
  return [12, 16, 40, 52, 56, 64, 108, 124].includes(dib);
}

/**
 * QuickTime (.mov) antigo ou gravado por câmera/iPhone nem sempre abre com o
 * átomo `ftyp`: o primeiro pode ser `moov`, `mdat`, `wide`, `free`, `skip` ou
 * `pnot`. O tipo do átomo sozinho é texto ASCII; o que o separa de um .txt é o
 * TAMANHO (uint32 big-endian nos bytes 0..3) — texto tem byte ≥ 0x09 ali, o que
 * daria ≥ 150 MB, maior que o arquivo (e que o teto de 50 MB).
 */
const ATOMOS_INICIAIS_QT = new Set(["moov", "mdat", "wide", "free", "skip", "pnot"]);
function pareceQuickTimeSemFtyp(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  const tipo = ascii(bytes, 4, 8);
  if (!ATOMOS_INICIAIS_QT.has(tipo)) return false;
  const tamanho = ((bytes[0]! << 24) >>> 0) + (bytes[1]! << 16) + (bytes[2]! << 8) + bytes[3]!;
  if (tamanho === 1) return bytes.length >= 16; // tamanho estendido de 64 bits a seguir
  if (tamanho === 0) return tipo === "mdat"; // "vai até o fim do arquivo"
  if (tipo === "wide") return tamanho === 8;
  return tamanho >= 8 && tamanho <= bytes.length;
}

const MARCAS_DE_IMAGEM_ISO = new Set(["heic", "heix", "hevc", "hevx", "mif1", "msf1", "avif", "avis"]);

/** A família do arquivo pelos bytes, ou `null` quando não reconhecida. */
export function farejarMidia(bytes: Uint8Array): FamiliaFarejada | null {
  // Imagem
  if (comecaCom(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image"; // PNG
  if (comecaCom(bytes, [0xff, 0xd8, 0xff])) return "image"; // JPEG
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image";
  if (comecaCom(bytes, [0x49, 0x49, 0x2a, 0x00]) || comecaCom(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return "image"; // TIFF (little/big-endian)
  }
  if (pareceBmp(bytes)) return "image";

  // Contêineres ISO-BMFF (`....ftyp<marca>`): MP4, MOV, M4A, 3GP, HEIC, AVIF.
  if (ascii(bytes, 4, 8) === "ftyp") {
    const marca = ascii(bytes, 8, 12).toLowerCase();
    if (MARCAS_DE_IMAGEM_ISO.has(marca)) return "image";
    if (marca.startsWith("m4a") || marca.startsWith("m4b")) return "audio";
    return "audiovisual";
  }
  if (comecaCom(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "audiovisual"; // WebM/Matroska
  if (pareceQuickTimeSemFtyp(bytes)) return "audiovisual"; // MOV sem `ftyp`

  // Texto UTF-16 com BOM ANTES do áudio: FF FE também é sincronia de quadro
  // MPEG. Só é texto se decodificar limpo, sem controle binário e sem marcação.
  const utf16 = textoUtf16(bytes);
  if (utf16 !== null && !pareceMarcacao(bytes)) {
    const codigos = Array.from(utf16, (c) => c.codePointAt(0)!);
    if (!temControleBinario(codigos)) return "text";
  }

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
    if (!temControleBinario(bytes.subarray(0, JANELA))) return "text";
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
    case "application/vnd.ms-powerpoint":
      return ["ole"];
    // O Windows com Excel instalado registra `.csv` como `application/vnd.ms-excel`,
    // e é esse o `file.type` que o navegador manda para uma planilha CSV. Os
    // bytes são texto — aceitar só OLE recusava todo CSV de quem usa Excel.
    case "application/vnd.ms-excel":
      return ["ole", "text"];
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
