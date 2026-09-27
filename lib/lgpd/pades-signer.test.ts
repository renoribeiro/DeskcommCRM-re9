/**
 * G4 — o aviso do PDF de LGPD nomeia a causa REAL de ele não estar assinado.
 *
 * Com `LGPD_SIGNING_KEY` configurada o signatário continuava dizendo
 * `pades_key_missing`, e o operador que já tinha posto a chave ia procurar a
 * chave de novo. O que falta nesse caso é a implementação.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { padesAssinaDeVerdade, signPdfPades } from "./pades-signer";

afterEach(() => {
  vi.unstubAllEnvs();
});

const PDF = Buffer.from("%PDF-1.7 fixture");

describe("signPdfPades — o aviso diz o que falta", () => {
  it("sem chave: pades_key_missing", async () => {
    vi.stubEnv("LGPD_SIGNING_KEY", "");
    const r = await signPdfPades(PDF);
    expect(r.signed_pades).toBe(false);
    expect(r.warning).toBe("pades_key_missing");
  });

  it("com chave e sem signatário implementado: pades_not_implemented", async () => {
    vi.stubEnv("LGPD_SIGNING_KEY", "uma-chave-longa-o-bastante");
    const r = await signPdfPades(PDF);
    expect(r.signed_pades).toBe(false);
    expect(r.warning).toBe("pades_not_implemented");
    expect(r.signed.equals(PDF)).toBe(true);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("com chave, o PDF continua saindo com a faixa de não assinado", () => {
    vi.stubEnv("LGPD_SIGNING_KEY", "uma-chave-longa-o-bastante");
    expect(padesAssinaDeVerdade()).toBe(false);
  });
});
