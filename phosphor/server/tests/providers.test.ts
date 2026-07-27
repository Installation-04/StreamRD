import { afterEach, describe, expect, it, vi } from "vitest";
import { AllDebridProvider } from "../src/providers/alldebrid";
import { PremiumizeProvider } from "../src/providers/premiumize";
import { RealDebridProvider } from "../src/providers/realdebrid";
import { TorboxProvider } from "../src/providers/torbox";
import { ProviderError } from "../src/providers/types";

const creds = { apiKey: "test-key" };

function mockFetchOnce(status: number, body: unknown) {
  const impl = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", impl);
  return impl;
}

afterEach(() => vi.unstubAllGlobals());

describe("RealDebridProvider", () => {
  const rd = new RealDebridProvider();

  it("maps /user to DebridUserInfo and sends the bearer token", async () => {
    const fetchMock = mockFetchOnce(200, {
      username: "alice",
      email: "alice@example.com",
      premium: 12345,
      expiration: "2027-01-01T00:00:00.000Z",
      points: 42,
      type: "premium",
    });
    const info = await rd.getUserInfo(creds);
    expect(info).toMatchObject({ provider: "realdebrid", username: "alice", premium: true, points: 42 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.real-debrid.com/rest/1.0/user");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
  });

  it("surfaces API errors as ProviderError", async () => {
    mockFetchOnce(401, { error: "bad_token" });
    await expect(rd.getUserInfo(creds)).rejects.toThrowError(/bad_token/);
  });

  it("rejects non-magnet torrent input", async () => {
    await expect(rd.addTorrent(creds, "https://example.com/file.torrent")).rejects.toThrowError(/magnet/i);
  });
});

describe("AllDebridProvider", () => {
  const ad = new AllDebridProvider();

  it("unwraps the success envelope", async () => {
    mockFetchOnce(200, {
      status: "success",
      data: { user: { username: "bob", email: "bob@example.com", isPremium: true, premiumUntil: 1893456000, fidelityPoints: 7 } },
    });
    const info = await ad.getUserInfo(creds);
    expect(info).toMatchObject({ provider: "alldebrid", username: "bob", premium: true });
  });

  it("throws on the error envelope even with HTTP 200", async () => {
    mockFetchOnce(200, { status: "error", error: { code: "AUTH_BAD_APIKEY", message: "Invalid API key" } });
    await expect(ad.getUserInfo(creds)).rejects.toThrowError(/Invalid API key/);
  });
});

describe("PremiumizeProvider", () => {
  const pm = new PremiumizeProvider();

  it("maps account info, deriving premium from premium_until", async () => {
    const future = Math.floor(Date.now() / 1000) + 86400;
    mockFetchOnce(200, { status: "success", customer_id: 123456, premium_until: future, space_used: 0 });
    const info = await pm.getUserInfo(creds);
    expect(info).toMatchObject({ provider: "premiumize", premium: true });
  });

  it("throws on Premiumize error payloads", async () => {
    mockFetchOnce(200, { status: "error", message: "customer not premium" });
    await expect(pm.getUserInfo(creds)).rejects.toThrowError(/not premium/);
  });
});

describe("TorboxProvider", () => {
  const tb = new TorboxProvider();

  it("maps /api/user/me via the success envelope", async () => {
    mockFetchOnce(200, { success: true, data: { id: 1, email: "carol@example.com", plan: 2 } });
    const info = await tb.getUserInfo(creds);
    expect(info).toMatchObject({ provider: "torbox", username: "carol@example.com", premium: true });
  });

  it("throws using the detail field when success is false", async () => {
    mockFetchOnce(200, { success: false, detail: "Invalid API key" });
    await expect(tb.getUserInfo(creds)).rejects.toThrowError(/Invalid API key/);
  });

  it("rejects non-magnet torrent input", async () => {
    await expect(tb.addTorrent(creds, "https://example.com/file.torrent")).rejects.toThrowError(/magnet/i);
  });

  it("addTorrent creates and reports finished torrents with pseudo-link file references", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/createtorrent")) {
        return Promise.resolve(new Response(JSON.stringify({ success: true, data: { torrent_id: 55 } }), { status: 200 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              id: 55,
              name: "Some.Show.S01E01",
              download_state: "completed",
              progress: 1,
              download_finished: true,
              files: [{ id: 7, short_name: "ep1", name: "ep1.mkv", size: 900 }],
            },
          }),
          { status: 200 }
        )
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const status = await tb.addTorrent(creds, "magnet:?xt=urn:btih:abc");
    expect(status).toMatchObject({ provider: "torbox", id: "55", phase: "finished", progress: 100, links: ["torbox://torrent/55/7"] });
  });

  it("unrestrictLink resolves a torbox:// pseudo-link via requestdl", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: "https://tb.example/dl/ep1.mkv" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const link = await tb.unrestrictLink(creds, "torbox://torrent/55/7");
    expect(link).toMatchObject({ provider: "torbox", url: "https://tb.example/dl/ep1.mkv" });
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/torrents/requestdl");
    expect(String(url)).toContain("torrent_id=55");
    expect(String(url)).toContain("file_id=7");
  });

  it("surfaces ProviderError instances", async () => {
    mockFetchOnce(401, { success: false, detail: "unauthorized" });
    await expect(tb.getUserInfo(creds)).rejects.toBeInstanceOf(ProviderError);
  });
});
