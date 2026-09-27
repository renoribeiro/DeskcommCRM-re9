/**
 * W7 — o upload de mídia de saída decide o tipo pelos BYTES, não pelo
 * `file.type` que o cliente declarou. SVG/HTML/XML nunca entram; a família
 * declarada tem de bater com a farejada.
 */
import { describe, expect, it } from "vitest";

import { conteudoBateComMime, farejarMidia } from "@/lib/messaging/media/farejar";
import { validateOutboundMedia } from "@/lib/messaging/media/upload-validation";

const b = (...partes: (number[] | string)[]): Uint8Array => {
  const out: number[] = [];
  for (const p of partes) {
    if (typeof p === "string") for (const c of p) out.push(c.charCodeAt(0));
    else out.push(...p);
  }
  return new Uint8Array(out);
};

const PNG = b([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "restodopng");
const JPEG = b([0xff, 0xd8, 0xff, 0xe0], "JFIF");
const WEBP = b("RIFF", [0, 0, 0, 0], "WEBPVP8 ");
const MP4 = b([0, 0, 0, 0x18], "ftypisom", [0, 0, 0, 0]);
const M4A = b([0, 0, 0, 0x18], "ftypM4A ", [0, 0, 0, 0]);
const WEBM = b([0x1a, 0x45, 0xdf, 0xa3], [0x9f, 0x42]);
const OGG = b("OggS", [0, 2]);
const MP3 = b("ID3", [3, 0]);
const PDF = b("%PDF-1.7\n");
const DOC = b([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const DOCX = b([0x50, 0x4b, 0x03, 0x04], "[Content_Types].xml");
const TXT = b("nome;telefone\nAna;11999990000\n");
const SVG = b('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = b("<!DOCTYPE html><html><body><script>fetch('/api')</script></body></html>");
const HTML_SOLTO = b("  <script>alert(document.cookie)</script>");

describe("farejarMidia", () => {
  it("reconhece as famílias aceitas", () => {
    expect(farejarMidia(PNG)).toBe("image");
    expect(farejarMidia(JPEG)).toBe("image");
    expect(farejarMidia(WEBP)).toBe("image");
    expect(farejarMidia(MP4)).toBe("audiovisual");
    expect(farejarMidia(WEBM)).toBe("audiovisual");
    expect(farejarMidia(M4A)).toBe("audio");
    expect(farejarMidia(OGG)).toBe("audio");
    expect(farejarMidia(MP3)).toBe("audio");
    expect(farejarMidia(PDF)).toBe("pdf");
    expect(farejarMidia(DOC)).toBe("ole");
    expect(farejarMidia(DOCX)).toBe("zip");
    expect(farejarMidia(TXT)).toBe("text");
  });

  it("marcação não é texto, nem nada", () => {
    expect(farejarMidia(SVG)).toBeNull();
    expect(farejarMidia(HTML)).toBeNull();
    expect(farejarMidia(HTML_SOLTO)).toBeNull();
  });
});

describe("conteudoBateComMime", () => {
  it("aceita o que é o que diz ser", () => {
    expect(conteudoBateComMime("image/png", PNG)).toBe(true);
    expect(conteudoBateComMime("image/jpeg", JPEG)).toBe(true);
    expect(conteudoBateComMime("video/mp4", MP4)).toBe(true);
    // Nota de voz do navegador: `audio/webm` e `audio/mp4` são contêineres AV.
    expect(conteudoBateComMime("audio/webm;codecs=opus", WEBM)).toBe(true);
    expect(conteudoBateComMime("audio/mp4", MP4)).toBe(true);
    expect(conteudoBateComMime("audio/ogg; codecs=opus", OGG)).toBe(true);
    expect(conteudoBateComMime("application/pdf", PDF)).toBe(true);
    expect(conteudoBateComMime("application/msword", DOC)).toBe(true);
    expect(
      conteudoBateComMime(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        DOCX,
      ),
    ).toBe(true);
    expect(conteudoBateComMime("text/csv", TXT)).toBe(true);
  });

  it("recusa SVG e HTML em qualquer declaração", () => {
    for (const mime of ["image/png", "image/svg+xml", "text/plain", "text/csv", "application/pdf"]) {
      expect(conteudoBateComMime(mime, SVG), `svg como ${mime}`).toBe(false);
      expect(conteudoBateComMime(mime, HTML), `html como ${mime}`).toBe(false);
    }
  });

  it("recusa família trocada", () => {
    expect(conteudoBateComMime("image/png", PDF)).toBe(false);
    expect(conteudoBateComMime("audio/ogg", PDF)).toBe(false);
    expect(conteudoBateComMime("application/pdf", PNG)).toBe(false);
    expect(conteudoBateComMime("text/plain", PNG)).toBe(false);
    expect(conteudoBateComMime("image/png", MP4)).toBe(false);
  });

  it("recusa o que não reconhece", () => {
    expect(conteudoBateComMime("application/zip", b([0x7f, 0x45, 0x4c, 0x46, 0, 1]))).toBe(false);
  });
});

describe("validateOutboundMedia — a declaração image/svg+xml não passa pelo prefixo image/", () => {
  it("recusa SVG declarado", () => {
    const r = validateOutboundMedia("image/svg+xml", 100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsupported_media_type");
  });

  it("a rota confere os bytes antes de guardar", async () => {
    const { readFileSync } = await import("node:fs");
    const fonte = readFileSync("app/api/v1/conversations/[id]/media/route.ts", "utf8");
    const confere = fonte.indexOf("conteudoBateComMime(mime, bruto)");
    const guarda = fonte.indexOf('.from("whatsapp-media")');
    expect(confere).toBeGreaterThan(0);
    expect(confere).toBeLessThan(guarda);
  });
});

/**
 * R5 — falsos positivos do farejador: arquivos legítimos que o usuário comum
 * manda e que a primeira versão recusava com 415.
 */
describe("farejador não recusa arquivo legítimo (R5)", () => {
  const utf16le = (texto: string): Uint8Array => {
    const out = [0xff, 0xfe];
    for (const c of texto) {
      const u = c.charCodeAt(0);
      out.push(u & 0xff, u >> 8);
    }
    return new Uint8Array(out);
  };
  const utf16be = (texto: string): Uint8Array => {
    const out = [0xfe, 0xff];
    for (const c of texto) {
      const u = c.charCodeAt(0);
      out.push(u >> 8, u & 0xff);
    }
    return new Uint8Array(out);
  };

  it("CSV do Windows com Excel chega como application/vnd.ms-excel e é texto", () => {
    expect(conteudoBateComMime("application/vnd.ms-excel", TXT)).toBe(true);
    // .xls de verdade continua aceito
    expect(conteudoBateComMime("application/vnd.ms-excel", DOC)).toBe(true);
    // e HTML/SVG disfarçado de planilha, não
    expect(conteudoBateComMime("application/vnd.ms-excel", HTML)).toBe(false);
    expect(conteudoBateComMime("application/vnd.ms-excel", SVG)).toBe(false);
  });

  it("CSV/TXT em UTF-16 com BOM (LE e BE) é texto — não binário, não áudio", () => {
    const csv = utf16le("nome;telefone\r\nJoão;11999990000\r\n");
    expect(farejarMidia(csv)).toBe("text");
    expect(conteudoBateComMime("text/csv", csv)).toBe(true);
    expect(conteudoBateComMime("text/plain", utf16be("olá, tudo bem?\n"))).toBe(true);
    expect(conteudoBateComMime("application/vnd.ms-excel", csv)).toBe(true);
  });

  it("marcação em UTF-16 continua recusada", () => {
    const svg16 = utf16le('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const html16 = utf16be("<!DOCTYPE html><html><script>x()</script></html>");
    for (const mime of ["text/plain", "text/csv", "application/vnd.ms-excel", "image/png"]) {
      expect(conteudoBateComMime(mime, svg16), `svg16 como ${mime}`).toBe(false);
      expect(conteudoBateComMime(mime, html16), `html16 como ${mime}`).toBe(false);
    }
  });

  it("FF FE seguido de binário não vira texto", () => {
    // surrogate baixo solto logo depois do BOM: UTF-16 inválido
    expect(farejarMidia(new Uint8Array([0xff, 0xfe, 0x00, 0xdc, 0x41, 0x00]))).not.toBe("text");
    // controle binário (0x01) decodificado
    expect(farejarMidia(new Uint8Array([0xff, 0xfe, 0x01, 0x00, 0x41, 0x00]))).not.toBe("text");
  });

  it("BMP e TIFF são imagem", () => {
    const bmp = new Uint8Array(40);
    bmp.set([0x42, 0x4d, 0x28, 0, 0, 0, 0, 0, 0, 0, 0x1a, 0, 0, 0, 40, 0, 0, 0]);
    const tiffLe = b([0x49, 0x49, 0x2a, 0x00], [8, 0, 0, 0]);
    const tiffBe = b([0x4d, 0x4d, 0x00, 0x2a], [0, 0, 0, 8]);
    expect(conteudoBateComMime("image/bmp", bmp)).toBe(true);
    expect(conteudoBateComMime("image/tiff", tiffLe)).toBe(true);
    expect(conteudoBateComMime("image/tiff", tiffBe)).toBe(true);
    // "BM" solto num CSV não é bitmap
    expect(farejarMidia(b("BMW;X1;2024\nBMW;X3;2025\n"))).toBe("text");
    expect(conteudoBateComMime("image/bmp", b("BMW;X1;2024\n"))).toBe(false);
  });

  it("MOV sem ftyp inicial (moov/mdat/wide/free) é vídeo", () => {
    const corpo = new Uint8Array(64);
    const mov = (tipo: string, tamanho: number): Uint8Array => {
      const x = corpo.slice();
      x.set([tamanho >>> 24, (tamanho >> 16) & 0xff, (tamanho >> 8) & 0xff, tamanho & 0xff]);
      for (let i = 0; i < 4; i++) x[4 + i] = tipo.charCodeAt(i);
      return x;
    };
    expect(conteudoBateComMime("video/quicktime", mov("wide", 8))).toBe(true);
    expect(conteudoBateComMime("video/quicktime", mov("moov", 64))).toBe(true);
    expect(conteudoBateComMime("video/quicktime", mov("mdat", 0))).toBe(true);
    expect(conteudoBateComMime("video/quicktime", mov("free", 32))).toBe(true);
    // texto que por acaso tem "free" nos bytes 4..8 continua texto
    expect(farejarMidia(b("tel:free call\n"))).toBe("text");
    expect(conteudoBateComMime("video/quicktime", b("tel:free call\n"))).toBe(false);
  });
});
