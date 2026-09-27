import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/v1/messages/{id}/media — auditoria P1 (c) e P3
 * (`docs/imobiliario/04-auditoria-seguranca-e-qualidade.md`).
 *
 * P1: o fallback que busca `media_url` pelo adapter do canal leva a credencial
 * do canal (no WAHA, a da INSTALAÇÃO). Ele só pode valer para mensagem
 * RECEBIDA — a `media_url` de saída era texto do cliente da API.
 *
 * P3: os bytes do remetente são servidos na origem do app. Só imagem raster,
 * áudio, vídeo e PDF saem `inline`; o resto é `attachment`, e tudo leva
 * `nosniff` e CSP `sandbox`.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const MSG_ID = "33333333-3333-4333-8333-333333333333";

const estado: { linha: Record<string, unknown> | null; midia: { buffer: Buffer; mime: string } } = {
  linha: null,
  midia: { buffer: Buffer.from("x"), mime: "image/jpeg" },
};
const fetchInboundMedia = vi.fn(async () => estado.midia);
const createSignedUrl = vi.fn(async () => ({
  data: { signedUrl: "https://storage.exemplo/assinada" },
  error: null,
}));

function cadeia(resultado: unknown) {
  const c: Record<string, unknown> = {};
  c.select = () => c;
  c.eq = () => c;
  c.maybeSingle = async () => ({ data: resultado, error: null });
  return c;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
    from: () => cadeia(estado.linha),
  }),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "u1", idioma: "pt-BR" }),
  resolveActiveOrg: async () => ({ orgId: ORG, role: "agent" }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => cadeia({ provider: "waha", waha_session_name: "sessao" }),
    storage: { from: () => ({ createSignedUrl }) },
  }),
}));
vi.mock("@/lib/channels", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/channels")>();
  return { ...real, getAdapter: () => ({ fetchInboundMedia }) };
});

import { GET } from "@/app/api/v1/messages/[id]/media/route";

async function chamar() {
  const req = new NextRequest(`http://localhost/api/v1/messages/${MSG_ID}/media`);
  return GET(req, { params: Promise.resolve({ id: MSG_ID }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  estado.midia = { buffer: Buffer.from("x"), mime: "image/jpeg" };
});

describe("P1 — o fallback por media_url vale só para mensagem recebida", () => {
  it("mensagem de SAÍDA com media_url: 404 e o adapter nem é chamado", async () => {
    estado.linha = {
      id: MSG_ID,
      direction: "outbound",
      media_url: "http://waha:3000/api/sessions",
      media_mime: "image/jpeg",
      media_storage_path: null,
      channel_session_id: "s1",
    };
    const res = await chamar();
    expect(res.status).toBe(404);
    expect(fetchInboundMedia).not.toHaveBeenCalled();
  });

  it("ECO do celular (saída com sent_via=external_device): serve pelo adapter", async () => {
    estado.linha = {
      id: MSG_ID,
      direction: "outbound",
      sent_via: "external_device",
      media_url: "http://localhost:3000/api/files/sessao/foto.jpg",
      media_mime: "image/jpeg",
      media_storage_path: null,
      channel_session_id: "s1",
    };
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(fetchInboundMedia).toHaveBeenCalledTimes(1);
  });

  it("saída pela API (sent_via=api) com media_url segue 404", async () => {
    estado.linha = {
      id: MSG_ID,
      direction: "outbound",
      sent_via: "api",
      media_url: "http://waha:3000/api/sessions",
      media_mime: "image/jpeg",
      media_storage_path: null,
      channel_session_id: "s1",
    };
    const res = await chamar();
    expect(res.status).toBe(404);
    expect(fetchInboundMedia).not.toHaveBeenCalled();
  });

  it("mensagem RECEBIDA ainda não persistida: serve pelo adapter (vacuidade)", async () => {
    estado.linha = {
      id: MSG_ID,
      direction: "inbound",
      media_url: "http://localhost:3000/api/files/sessao/a.jpg",
      media_mime: "image/jpeg",
      media_storage_path: null,
      channel_session_id: "s1",
    };
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(fetchInboundMedia).toHaveBeenCalledTimes(1);
  });
});

describe("P3 — bytes do remetente na origem do app", () => {
  function recebida() {
    estado.linha = {
      id: MSG_ID,
      direction: "inbound",
      media_url: "http://localhost:3000/api/files/sessao/a.bin",
      media_mime: null,
      media_storage_path: null,
      channel_session_id: "s1",
    };
  }

  it("HTML do remetente sai como download, sob sandbox e nosniff", async () => {
    recebida();
    estado.midia = { buffer: Buffer.from("<script>alert(1)</script>"), mime: "text/html" };
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe("attachment");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("SVG também é download (script embutido)", async () => {
    recebida();
    estado.midia = { buffer: Buffer.from("<svg/>"), mime: "image/svg+xml" };
    const res = await chamar();
    expect(res.headers.get("content-disposition")).toBe("attachment");
  });

  it("imagem raster segue inline, com os mesmos cabeçalhos de defesa", async () => {
    recebida();
    estado.midia = { buffer: Buffer.from("x"), mime: "image/png" };
    const res = await chamar();
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("PDF servido pela origem do app sai como download (o Chrome não abre PDF sob sandbox)", async () => {
    recebida();
    estado.midia = { buffer: Buffer.from("%PDF-1.4"), mime: "application/pdf" };
    const res = await chamar();
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe("attachment");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("PDF já persistido abre no navegador pela URL assinada (outra origem)", async () => {
    estado.linha = {
      id: MSG_ID,
      direction: "inbound",
      media_url: null,
      media_mime: "application/pdf",
      media_storage_path: `${ORG}/c/a.pdf`,
      channel_session_id: "s1",
    };
    const res = await chamar();
    expect(res.status).toBe(302);
    expect(createSignedUrl).toHaveBeenCalledWith(`${ORG}/c/a.pdf`, 3600, undefined);
  });

  it("persistida com tipo fora da lista: a URL assinada pede download", async () => {
    estado.linha = {
      id: MSG_ID,
      direction: "inbound",
      media_url: null,
      media_mime: "text/html",
      media_storage_path: `${ORG}/c/a.html`,
      channel_session_id: "s1",
    };
    const res = await chamar();
    expect(res.status).toBe(302);
    expect(createSignedUrl).toHaveBeenCalledWith(`${ORG}/c/a.html`, 3600, { download: true });
  });
});
