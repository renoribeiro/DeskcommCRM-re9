import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  chaveDoEstadoOAuth,
  ROTULO_DA_CHAVE_DO_ESTADO_OAUTH,
} from "@/lib/auth/chave-do-estado-oauth";
import * as agenda from "@/lib/agenda/google/estado";
import { assinarVinculo, vinculoConfere } from "@/lib/agenda/google/vinculo";
import { issueState, verifyState } from "@/lib/nuvemshop/state";
import * as ads from "@/lib/plataformas-de-anuncio/google/estado";

/**
 * Auditoria P7 (`docs/imobiliario/04-auditoria-seguranca-e-qualidade.md`).
 *
 * `INTERNAL_SECRET` é também o bearer dos crons — e o runbook do relógio HTTP
 * o mandava cadastrar num serviço de terceiros. Com ele assinando o `state`
 * CRU, quem visse o bearer forjava o `state` dos OAuth. Agora a chave é
 * `HMAC(INTERNAL_SECRET, rótulo)`: um `state` assinado com o segredo cru é
 * RECUSADO, e o emitido pelo produto continua valendo.
 */

const SEGREDO = "segredo-da-instalacao-com-32-chars!!";
const AGORA = new Date("2026-09-27T12:00:00Z");

/** O que um atacante com o bearer do cron faria: assinar com o segredo cru. */
function forjarComSegredoCru(carga: string): string {
  const sig = createHmac("sha256", SEGREDO).update(carga, "utf8").digest("hex");
  return `${Buffer.from(carga, "utf8").toString("base64url")}.${sig}`;
}

afterEach(() => vi.unstubAllEnvs());

describe("chaveDoEstadoOAuth", () => {
  it("é HMAC-SHA256(segredo, rótulo versionado) e difere do segredo", () => {
    const esperado = createHmac("sha256", SEGREDO).update(ROTULO_DA_CHAVE_DO_ESTADO_OAUTH).digest();
    expect(chaveDoEstadoOAuth(SEGREDO).equals(esperado)).toBe(true);
    expect(ROTULO_DA_CHAVE_DO_ESTADO_OAUTH).toMatch(/oauth-state:v\d+$/);
    expect(chaveDoEstadoOAuth(SEGREDO).equals(Buffer.from(SEGREDO))).toBe(false);
  });
});

describe("agenda Google", () => {
  it("state forjado com o INTERNAL_SECRET cru é recusado", () => {
    const expira = AGORA.getTime() + 60_000;
    const forjado = forjarComSegredoCru(`org-1.user-1.nonce.${expira}`);
    expect(agenda.verificarEstado(forjado, { segredo: SEGREDO, agora: AGORA })).toBeNull();
  });

  it("state emitido pelo produto continua valendo (vacuidade)", () => {
    const t = agenda.emitirEstado(
      { organizationId: "org-1", userId: "user-1" },
      { segredo: SEGREDO, agora: AGORA },
    );
    expect(agenda.verificarEstado(t, { segredo: SEGREDO, agora: AGORA })?.userId).toBe("user-1");
  });

  it("vínculo assinado com o segredo cru não confere", () => {
    const cru = createHmac("sha256", SEGREDO).update("n1", "utf8").digest("base64url");
    expect(vinculoConfere(cru, "n1", SEGREDO)).toBe(false);
    expect(vinculoConfere(assinarVinculo("n1", SEGREDO), "n1", SEGREDO)).toBe(true);
  });
});

describe("Google Ads", () => {
  it("state forjado com o INTERNAL_SECRET cru é recusado", () => {
    const expira = AGORA.getTime() + 60_000;
    const forjado = forjarComSegredoCru(`org-1.user-1.nonce.${expira}.google_ads`);
    expect(ads.verificarEstado(forjado, { segredo: SEGREDO, agora: AGORA })).toBeNull();
  });

  it("state emitido pelo produto continua valendo (vacuidade)", () => {
    const t = ads.emitirEstado(
      { organizationId: "org-1", userId: "user-1" },
      { segredo: SEGREDO, agora: AGORA },
    );
    expect(ads.verificarEstado(t, { segredo: SEGREDO, agora: AGORA })?.organizationId).toBe("org-1");
  });
});

describe("Nuvemshop", () => {
  it("state forjado com o INTERNAL_SECRET cru é recusado", () => {
    vi.stubEnv("INTERNAL_SECRET", SEGREDO);
    const forjado = forjarComSegredoCru(`org-1.nonce.${Date.now() + 60_000}`);
    expect(verifyState(forjado)).toBeNull();
  });

  it("state emitido pelo produto continua valendo (vacuidade)", () => {
    vi.stubEnv("INTERNAL_SECRET", SEGREDO);
    expect(verifyState(issueState("org-1"))?.orgId).toBe("org-1");
  });
});
