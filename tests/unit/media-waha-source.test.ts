import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { caminhoDeArquivoDoWaha, fetchWahaMedia } from "@/lib/messaging/media/waha-source";
import { MediaTooLargeError } from "@/lib/messaging/media/types";

const WAHA_BASE = "http://localhost:3030";

describe("fetchWahaMedia", () => {
  beforeEach(() => {
    vi.stubEnv("WAHA_API_BASE_URL", WAHA_BASE);
    vi.stubEnv("WAHA_API_KEY", "hash123");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("baixa a mídia com X-Api-Key e retorna buffer + mime", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(bytes, { status: 200, headers: { "content-type": "image/jpeg" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const media = await fetchWahaMedia(`${WAHA_BASE}/api/files/sessao/abc.jpg`, null, "sessao");
    expect(media.mime).toBe("image/jpeg");
    expect(media.buffer.byteLength).toBe(3);
    expect(fetchMock).toHaveBeenCalledWith(
      `${WAHA_BASE}/api/files/sessao/abc.jpg`,
      expect.objectContaining({ headers: { "X-Api-Key": "hash123" } }),
    );
  });

  it("reescreve host arbitrário p/ a base do WAHA (anti-SSRF por construção)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(new ArrayBuffer(2), { status: 200, headers: { "content-type": "image/jpeg" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await fetchWahaMedia("http://evil.example.com/api/files/sessao/x.jpg?q=1", null, "sessao");
    // A query também cai (auditoria P1): arquivo do WAHA não precisa dela.
    expect(fetchMock).toHaveBeenCalledWith(`${WAHA_BASE}/api/files/sessao/x.jpg`, expect.anything());
  });

  it("reescreve a porta interna anunciada pelo WAHA p/ a base real", async () => {
    // WAHA anuncia localhost:3000 (porta interna do container); no host é 3030.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(new ArrayBuffer(2), { status: 200, headers: { "content-type": "image/webp" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await fetchWahaMedia("http://localhost:3000/api/files/sessao/sticker.webp", null, "sessao");
    expect(fetchMock).toHaveBeenCalledWith(
      `${WAHA_BASE}/api/files/sessao/sticker.webp`,
      expect.anything(),
    );
  });

  it("propaga status HTTP de erro", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    await expect(fetchWahaMedia(`${WAHA_BASE}/api/files/sessao/gone.jpg`, null, "sessao")).rejects.toThrow(
      "waha_media_404",
    );
  });

  it("rejeita mídia acima de 50MB", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new ArrayBuffer(8), {
          status: 200,
          headers: { "content-type": "video/mp4", "content-length": String(60 * 1024 * 1024) },
        }),
      ),
    );
    await expect(fetchWahaMedia(`${WAHA_BASE}/api/files/sessao/big.mp4`, null, "sessao")).rejects.toThrow(
      MediaTooLargeError,
    );
  });

  it("usa hintMime quando o content-type vem vazio", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(new ArrayBuffer(2), { status: 200 })),
    );
    const media = await fetchWahaMedia(`${WAHA_BASE}/api/files/sessao/x`, "audio/ogg; codecs=opus", "sessao");
    expect(media.mime).toBe("audio/ogg; codecs=opus");
  });

  it("mapeia mediaUrl malformada p/ waha_media_untrusted_host", async () => {
    await expect(fetchWahaMedia("not-a-url")).rejects.toThrow("waha_media_untrusted_host");
  });

  /**
   * Auditoria P1 (docs/imobiliario/04-auditoria-seguranca-e-qualidade.md): a
   * API key do WAHA é da INSTALAÇÃO. Reconstruir só o host deixava qualquer
   * endpoint da API alcançável com ela. O critério é `fetch` NÃO ser chamado.
   */
  describe("só busca caminho de arquivo do WAHA", () => {
    const RECUSADAS = [
      ["lista de sessões", "http://localhost:3000/api/sessions"],
      ["conversas de outra sessão", "http://localhost:3000/api/outra/chats"],
      ["travessia crua", "http://localhost:3000/api/files/../sessions"],
      ["travessia codificada", "http://localhost:3000/api/files/%2e%2e/sessions"],
      ["barra codificada", "http://localhost:3000/api/files/s%2F..%2Fx"],
      ["barra invertida", "http://localhost:3000/api/files/s\\x.jpg"],
      ["segmentos demais", "http://localhost:3000/api/files/a/b/c.jpg"],
      ["segmento vazio", "http://localhost:3000/api/files//x.jpg"],
      ["esquema não-http", "file:///api/files/x.jpg"],
      ["sessão de outra organização", "http://localhost:3000/api/files/outra/ABC.bin"],
      // R11: sem o segmento da sessão não há como conferir a organização.
      ["arquivo sem a sessão no caminho", "http://localhost:3000/api/files/ABC.bin"],
    ] as const;

    for (const [rotulo, url] of RECUSADAS) {
      it(`recusa ${rotulo} — sem chamar fetch`, async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        await expect(fetchWahaMedia(url, null, "sessao")).rejects.toThrow(
          "waha_media_untrusted_host",
        );
        expect(fetchMock).not.toHaveBeenCalled();
      });
    }

    it("aceita o formato real /api/files/<sessão>/<arquivo> da própria sessão", () => {
      expect(
        caminhoDeArquivoDoWaha("http://localhost:3000/api/files/sessao/false_5511@c.us_3EB0.jpeg", "sessao"),
      ).toBe("/api/files/sessao/false_5511@c.us_3EB0.jpeg");
    });

    it("sem sessionRef não há com o que conferir: recusa até o formato real (R11)", () => {
      expect(caminhoDeArquivoDoWaha("http://localhost:3000/api/files/sessao/a.jpg")).toBeNull();
      expect(caminhoDeArquivoDoWaha("http://localhost:3000/api/files/sessao/a.jpg", "")).toBeNull();
      expect(caminhoDeArquivoDoWaha("http://localhost:3000/api/files/a.jpg", "sessao")).toBeNull();
    });

    it("não segue redirect com a X-Api-Key", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(new ArrayBuffer(1), { status: 200, headers: { "content-type": "image/jpeg" } }),
      );
      vi.stubGlobal("fetch", fetchMock);
      await fetchWahaMedia(`${WAHA_BASE}/api/files/sessao/a.jpg`, null, "sessao");
      expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
    });
  });
});
