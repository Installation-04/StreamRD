import { afterEach, expect, it, vi } from "vitest";
import type { DebridConfig } from "@prisma/client";
import { DEFAULT_SERVER_SETTINGS } from "../src/settings";
import { ProviderError, providerFetch } from "../src/providers/types";
const mocks = vi.hoisted(() => ({ server: vi.fn(), providers: vi.fn(), resolve: vi.fn() }));
vi.mock("../src/settings", async (original) => ({
  ...await original<typeof import("../src/settings")>(),
  getServerSettings: mocks.server, getProviderSettings: mocks.providers,
}));
vi.mock("../src/providers/registry", () => ({ getProvider: (id: string) => ({
  id, unrestrictLink: (...args: unknown[]) => mocks.resolve(id, ...args),
}) }));
vi.mock("../src/logger", () => ({ logEvent: vi.fn() }));
import { DebridManager } from "../src/providers/manager";
const cfg = { primaryProvider: "realdebrid", fallbackOrder: "[]", realDebridToken: "rd", allDebridApiKey: "ad" } as DebridConfig;
const sources = ["one", "two", "three"].map(url => ({ kind: "link" as const, url }));
function setup() {
  mocks.server.mockResolvedValue(DEFAULT_SERVER_SETTINGS);
  mocks.providers.mockResolvedValue({});
}
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it("caps total source/provider attempts and snapshots settings", async () => {
  setup(); mocks.resolve.mockRejectedValue(new Error("unavailable"));
  await expect(new DebridManager().resolveStream(cfg, sources)).rejects.toThrow("unavailable");
  expect(mocks.resolve).toHaveBeenCalledTimes(3);
  expect(mocks.server).toHaveBeenCalledTimes(1);
  expect(mocks.providers).toHaveBeenCalledTimes(1);
});
it("skips unauthorized providers on subsequent sources", async () => {
  setup(); mocks.resolve.mockImplementation(async (id, _creds, url) => {
    if (id === "realdebrid") throw new ProviderError(id, "unauthorized", 401);
    if (url === "one") throw new Error("bad source");
    return { provider: id, url: "https://stream.example/video", filename: "video.mp4" };
  });
  expect((await new DebridManager().resolveStream(cfg, sources)).provider).toBe("alldebrid");
  expect(mocks.resolve.mock.calls.map(call => call[0])).toEqual(["realdebrid", "alldebrid", "alldebrid"]);
});
it("deduplicates provider order", async () => {
  setup(); mocks.resolve.mockRejectedValue(new Error("unavailable"));
  await expect(new DebridManager().resolveStream({ ...cfg, fallbackOrder: '["alldebrid","alldebrid"]' }, sources.slice(0, 1))).rejects.toThrow();
  expect(mocks.resolve).toHaveBeenCalledTimes(2);
});
it("stops starting attempts once the shared deadline expires", async () => {
  setup(); vi.useFakeTimers();
  mocks.resolve.mockImplementation(async () => {
    vi.setSystemTime(Date.now() + 45001); throw new Error("slow upstream");
  });
  await expect(new DebridManager().resolveStream(cfg, sources)).rejects.toThrow();
  expect(mocks.resolve).toHaveBeenCalledTimes(1);
});
it("rejects expired deadlines without sending upstream requests", async () => {
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  await expect(providerFetch("realdebrid", "https://example.com", {}, 15000, Date.now() - 1)).rejects.toThrow("deadline");
  expect(fetchMock).not.toHaveBeenCalled();
});
it("keeps the deadline active while reading a response body", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      init.signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")));
    },
  }))));
  const pending = expect(providerFetch("realdebrid", "https://example.com", {}, 15000, Date.now() + 100)).rejects.toThrow("timed out after 100ms");
  await vi.advanceTimersByTimeAsync(100);
  await pending;
});
