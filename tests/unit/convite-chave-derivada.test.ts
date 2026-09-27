/**
 * R8 — o convite é assinado com chave DERIVADA, e sem segredo o convite fecha.
 *
 * Antes: `HMAC(INTERNAL_SECRET cru, corpo)`, e sem segredo, `"dev-fallback"`.
 * O `INTERNAL_SECRET` é também o bearer dos crons (e o runbook do relógio HTTP
 * o manda para um serviço de terceiros): quem o visse forjava convite de admin.
 * Agora a chave é `HMAC(segredo, "crm:invite-token:v1")`, e sem segredo fora do
 * ambiente de teste, assinar e conferir lançam.
 */
import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConviteSemSegredoError,
  ROTULO_DA_CHAVE_DO_CONVITE,
  chaveDoConvite,
  signInviteToken,
  verifyInviteToken,
  type InvitePayload,
} from "@/lib/auth/invite-token";

const SEGREDO = "segredo-interno-de-teste-com-32-caracteres!!";

const PAYLOAD: InvitePayload = {
  invite_id: "bbbbbbbb-0000-4000-8000-000000000001",
  email: "pessoa@exemplo.com",
  organization_id: "bbbbbbbb-0000-4000-8000-0000000000a1",
  role: "admin",
  exp: Math.floor(Date.now() / 1000) + 3600,
};

function assinarCom(chave: string | Buffer, payload: InvitePayload = PAYLOAD): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${createHmac("sha256", chave).update(body).digest().toString("base64url")}`;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

function comSegredo(valor: string | undefined, nodeEnv = "production") {
  vi.stubEnv("INVITE_TOKEN_SECRET", "");
  vi.stubEnv("INTERNAL_SECRET", valor ?? "");
  vi.stubEnv("NODE_ENV", nodeEnv);
}

describe("convite — chave derivada do INTERNAL_SECRET", () => {
  it("o rótulo é versionado e não leva marca", () => {
    expect(ROTULO_DA_CHAVE_DO_CONVITE).toBe("crm:invite-token:v1");
  });

  it("assina com HMAC(segredo, rótulo), e o token confere", () => {
    comSegredo(SEGREDO);
    const token = signInviteToken(PAYLOAD);
    expect(token).toBe(assinarCom(chaveDoConvite(SEGREDO)));
    expect(verifyInviteToken(token)?.invite_id).toBe(PAYLOAD.invite_id);
  });

  it("token assinado com o INTERNAL_SECRET CRU (o bearer dos crons) é recusado", () => {
    comSegredo(SEGREDO);
    expect(verifyInviteToken(assinarCom(SEGREDO))).toBeNull();
  });

  it("token assinado com o antigo 'dev-fallback' é recusado", () => {
    comSegredo(SEGREDO);
    expect(verifyInviteToken(assinarCom("dev-fallback"))).toBeNull();
  });
});

describe("convite — sem segredo, fecha", () => {
  it("em produção, sem INTERNAL_SECRET, assinar lança", () => {
    comSegredo(undefined);
    expect(() => signInviteToken(PAYLOAD)).toThrow(ConviteSemSegredoError);
  });

  it("em produção, sem INTERNAL_SECRET, conferir lança — nunca aceita pela chave pública", () => {
    comSegredo(undefined);
    expect(() => verifyInviteToken(assinarCom("dev-fallback"))).toThrow(ConviteSemSegredoError);
  });

  it("segredo só de espaços conta como ausente", () => {
    comSegredo("   ");
    expect(() => signInviteToken(PAYLOAD)).toThrow(ConviteSemSegredoError);
  });

  it("em desenvolvimento também fecha (o .env.example entrega INTERNAL_SECRET vazio)", () => {
    comSegredo(undefined, "development");
    expect(() => signInviteToken(PAYLOAD)).toThrow(ConviteSemSegredoError);
  });

  it("no ambiente de teste, sem segredo, a chave só de teste permite assinar e conferir", () => {
    comSegredo(undefined, "test");
    const token = signInviteToken(PAYLOAD);
    expect(verifyInviteToken(token)?.email).toBe(PAYLOAD.email);
  });
});
