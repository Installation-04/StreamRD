import { afterEach, describe, expect, it, vi } from "vitest";
import { AllDebridProvider } from "../src/providers/alldebrid";
import { PremiumizeProvider } from "../src/providers/premiumize";
import { RealDebridProvider } from "../src/providers/realdebrid";
import { ProviderError } from "../src/providers/types";

const creds = { apiKey: "test-key" };

function mockFetchOnce(status: number, body: unknown) {
  const impl = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
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
    expect(info).toMatchObject({
      provider: "realdebrid",
      username: "alice",
      premium: true,
      points: 42,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.real-debrid.com/rest/1.0/user");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-key"
    );
  });

  it("unrestricts a link", async () => {
    mockFetchOnce(200, {
      download: "https://rd.example/file.mkv",
      filename: "file.mkv",
      filesize: 1000,
      mimeType: "video/x-matroska",
    });
    const link = await rd.unrestrictLink(creds, "https://host.example/x");
    expect(link.url).toBe("https://rd.example/file.mkv");
    expect(link.provider).toBe("realdebrid");
  });

  it("surfaces API errors as ProviderError with the API's message", async () => {
    mockFetchOnce(401, { error: "bad_token" });
    await expect(rd.getUserInfo(creds)).rejects.toThrowError(/bad_token/);
    mockFetchOnce(401, { error: "bad_token" });
    await expect(rd.getUserInfo(creds)).rejects.toBeInstanceOf(ProviderError);
  });

  it("rejects non-magnet torrent input", async () => {
    await expect(
      rd.addTorrent(creds, "https://example.com/file.torrent")
    ).rejects.toThrowError(/magnet/i);
  });
});

describe("AllDebridProvider", () => {
  const ad = new AllDebridProvider();

  it("unwraps the success envelope", async () => {
    mockFetchOnce(200, {
      status: "success",
      data: {
        user: {
          username: "bob",
          email: "bob@example.com",
          isPremium: true,
          premiumUntil: 1893456000,
          fidelityPoints: 7,
        },
      },
    });
    const info = await ad.getUserInfo(creds);
    expect(info).toMatchObject({ provider: "alldebrid", username: "bob", premium: true });
  });

  it("throws on the error envelope even with HTTP 200", async () => {
    mockFetchOnce(200, {
      status: "error",
      error: { code: "AUTH_BAD_APIKEY", message: "Invalid API key" },
    });
    await expect(ad.getUserInfo(creds)).rejects.toThrowError(/Invalid API key/);
  });

  it("maps magnet status to a uniform TorrentStatus", async () => {
    mockFetchOnce(200, {
      status: "success",
      data: {
        magnets: {
          id: 99,
          filename: "show.mkv",
          statusCode: 4,
          downloaded: 100,
          size: 100,
          links: [{ link: "https://ad.example/dl/1" }],
        },
      },
    });
    const status = await ad.getTorrentStatus(creds, "99");
    expect(status).toMatchObject({
      provider: "alldebrid",
      id: "99",
      phase: "finished",
      progress: 100,
      links: ["https://ad.example/dl/1"],
    });
  });
});

describe("PremiumizeProvider", () => {
  const pm = new PremiumizeProvider();

  it("maps account info, deriving premium from premium_until", async () => {
    const future = Math.floor(Date.now() / 1000) + 86400;
    mockFetchOnce(200, {
      status: "success",
      customer_id: 123456,
      premium_until: future,
      space_used: 0,
    });
    const info = await pm.getUserInfo(creds);
    expect(info).toMatchObject({ provider: "premiumize", premium: true });
  });

  it("returns the first direct-download entry when unrestricting", async () => {
    mockFetchOnce(200, {
      status: "success",
      content: [
        { link: "https://pm.example/dl/movie.mp4", path: "folder/movie.mp4", size: 5 },
      ],
    });
    const link = await pm.unrestrictLink(creds, "https://host.example/y");
    expect(link).toMatchObject({
      provider: "premiumize",
      url: "https://pm.example/dl/movie.mp4",
      filename: "movie.mp4",
    });
  });

  it("throws on Premiumize error payloads", async () => {
    mockFetchOnce(200, { status: "error", message: "customer not premium" });
    await expect(pm.getUserInfo(creds)).rejects.toThrowError(/not premium/);
  });
});
