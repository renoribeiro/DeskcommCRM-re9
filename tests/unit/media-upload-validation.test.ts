import { describe, expect, it } from "vitest";

import {
  caminhoDeStorageDentroDe,
  isMediaPathOwnedBy,
  validateOutboundMedia,
} from "@/lib/messaging/media/upload-validation";

describe("validateOutboundMedia", () => {
  it("classifica mimes suportados no kind certo", () => {
    expect(validateOutboundMedia("image/jpeg", 1000)).toEqual({ ok: true, kind: "image" });
    expect(validateOutboundMedia("image/webp", 1000)).toEqual({ ok: true, kind: "image" });
    expect(validateOutboundMedia("video/mp4", 1000)).toEqual({ ok: true, kind: "video" });
    expect(validateOutboundMedia("audio/ogg; codecs=opus", 1000)).toEqual({ ok: true, kind: "audio" });
    expect(validateOutboundMedia("audio/webm", 1000)).toEqual({ ok: true, kind: "audio" });
    expect(validateOutboundMedia("application/pdf", 1000)).toEqual({ ok: true, kind: "document" });
    expect(validateOutboundMedia("text/csv", 1000)).toEqual({ ok: true, kind: "document" });
  });
  it("rejeita mime não suportado", () => {
    const r = validateOutboundMedia("application/x-msdownload", 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsupported_media_type");
  });
  it("rejeita acima de 50MB", () => {
    const r = validateOutboundMedia("image/jpeg", 51 * 1024 * 1024);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("payload_too_large");
  });
  it("rejeita arquivo vazio", () => {
    const r = validateOutboundMedia("image/jpeg", 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("validation_failed");
  });
});

/**
 * Auditoria P2 (docs/imobiliario/04-auditoria-seguranca-e-qualidade.md):
 * `startsWith` sozinho aceitava `org/conv/../../outraOrg/arquivo`.
 */
describe("isMediaPathOwnedBy / caminhoDeStorageDentroDe — travessia", () => {
  const org = "11111111-1111-4111-8111-111111111111";
  const conv = "22222222-2222-4222-8222-222222222222";
  const outra = "99999999-9999-4999-8999-999999999999";

  const RECUSADOS: Array<[string, string]> = [
    ["`..` que sai da conversa", `${org}/${conv}/../../${outra}/c/x.jpg`],
    ["`..` que volta para a mesma conversa", `${org}/${conv}/../${conv}/x.jpg`],
    ["`.` como segmento", `${org}/${conv}/./x.jpg`],
    ["barra dupla", `${org}/${conv}//x.jpg`],
    ["barra invertida", `${org}/${conv}/..\\..\\${outra}/x.jpg`],
    ["percent-encoding", `${org}/${conv}/%2e%2e/%2e%2e/${outra}/x.jpg`],
    ["caractere de controle", `${org}/${conv}/x\u0000.jpg`],
    ["quebra de linha", `${org}/${conv}/x\n.jpg`],
    ["só o prefixo", `${org}/${conv}/`],
    ["absoluto", `/${org}/${conv}/x.jpg`],
    ["termina em barra", `${org}/${conv}/pasta/`],
  ];

  for (const [rotulo, caminho] of RECUSADOS) {
    it(`recusa ${rotulo}`, () => {
      expect(isMediaPathOwnedBy(caminho, org, conv)).toBe(false);
    });
  }

  it("aceita o caminho que a rota de upload gera (vacuidade)", () => {
    expect(isMediaPathOwnedBy(`${org}/${conv}/out-3f1c.jpg`, org, conv)).toBe(true);
  });

  it("o helper compartilhado exige prefixo terminado em barra", () => {
    expect(caminhoDeStorageDentroDe(`${org}/x.jpg`, org)).toBe(false);
    expect(caminhoDeStorageDentroDe(`${org}/x.jpg`, `${org}/`)).toBe(true);
  });
});
