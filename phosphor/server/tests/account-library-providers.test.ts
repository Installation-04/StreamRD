import { afterEach, describe, expect, it, vi } from "vitest";
import { playAccountItem, scanAccountPage } from "../src/providers/account-library";
import { PROVIDER_IDS, ProviderError, ProviderId } from "../src/providers/types";

const creds = { apiKey: "private-fixture-key" };
const response = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
function mock(handler: (url: URL, init: RequestInit) => unknown) {
  const fetch = vi.fn().mockImplementation(async (url: URL, init: RequestInit) => {
    const result = handler(new URL(String(url)), init); return result instanceof Response ? result : response(result);
  }); vi.stubGlobal("fetch", fetch); return fetch;
}
const rd = (ref: string | number, patch: Record<string, unknown> = {}) => ({ id: String(ref), filename: `Fixture.${ref}.2020.mkv`, status: "downloaded", progress: 100, links: ["https://provider.invalid/private-link"], ...patch });
const ad = (ref: string | number, patch: Record<string, unknown> = {}) => ({ id: Number(ref), filename: `Fixture.${ref}.2020.mkv`, statusCode: 4, downloaded: 100, size: 100, links: [{ link: "https://provider.invalid/private-link" }], ...patch });
const tb = (ref: string | number, patch: Record<string, unknown> = {}) => ({ id: Number(ref), name: `Fixture.${ref}.2020.mkv`, download_state: "completed", download_finished: true, progress: 1, files: [], ...patch });
const opaque = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const videoStatus = (ref = "torrent-a", patch: Record<string, unknown> = {}) => rd(ref, { files: [{ id: 1, path: "/Film.mkv", bytes: 400, selected: 1 }], links: ["https://hoster.invalid/film"], ...patch });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("read-only account scanning", () => {
  it("walks Real-Debrid pages beyond its default first50 and never returns links or credentials", async () => {
    const calls = mock((url, init) => {
      expect(url.pathname).toBe("/rest/1.0/torrents"); expect(url.searchParams.get("limit")).toBe("100"); expect(init.method ?? "GET").toBe("GET");
      expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${creds.apiKey}`); expect(init.redirect).toBe("error");
      const page = Number(url.searchParams.get("page")); return page === 1 ? Array.from({ length: 100 }, (_, i) => rd(i + 1)) : page === 2 ? Array.from({ length: 51 }, (_, i) => rd(i + 101)) : [];
    });
    const first = await scanAccountPage("realdebrid", creds); expect(first.items).toHaveLength(100); expect(first.nextCursor).not.toBeNull();
    const second = await scanAccountPage("realdebrid", creds, first.nextCursor!); expect(second.items).toHaveLength(51);
    const last = await scanAccountPage("realdebrid", creds, second.nextCursor!); expect(last).toEqual({ items: [], nextCursor: null });
    expect(new Set([...first.items, ...second.items].map(item => item.providerRef)).size).toBe(151); expect(calls).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(first)).not.toContain("https:"); expect(JSON.stringify(first)).not.toContain(creds.apiKey);
  });
  it("continues through short RD pages instead of assuming fewer than100 means complete", async () => {
    mock(url => Number(url.searchParams.get("page")) === 1 ? Array.from({ length: 50 }, (_, i) => rd(i + 1)) : Number(url.searchParams.get("page")) === 2 ? [rd(51)] : []);
    const a = await scanAccountPage("realdebrid", creds), b = await scanAccountPage("realdebrid", creds, a.nextCursor!), c = await scanAccountPage("realdebrid", creds, b.nextCursor!);
    expect(a.items.length + b.items.length).toBe(51); expect(c.nextCursor).toBeNull();
  });
  it("detects a provider ignoring page parameters instead of scanning forever", async () => {
    mock(() => [rd(1)]); const first = await scanAccountPage("realdebrid", creds);
    await expect(scanAccountPage("realdebrid", creds, first.nextCursor!)).rejects.toMatchObject({ statusCode: 502 });
  });
  it.each(["invalid+cursor", "x".repeat(8193), opaque({ v: 1, p: "alldebrid", after: "1" }), opaque({ v: 1, p: "realdebrid", page: -1, previous: "a".repeat(64) })])("rejects malformed/provider-mismatched scan cursors", async cursor => {
    const calls = mock(() => []); await expect(scanAccountPage("realdebrid", creds, cursor)).rejects.toMatchObject({ statusCode: 400 }); expect(calls).not.toHaveBeenCalled();
  });
  it("uses bounded local keyset pages for AllDebrid and tolerates provider reordering", async () => {
    const rows = Array.from({ length: 121 }, (_, i) => ad(i + 1)); let read = 0;
    const calls = mock((url, init) => { expect(url.pathname).toBe("/v4.1/magnet/status"); expect(url.searchParams.get("apikey")).toBe(creds.apiKey); expect(init.method ?? "GET").toBe("GET"); return { status: "success", data: { magnets: read++ ? [...rows].reverse() : rows } }; });
    const a = await scanAccountPage("alldebrid", creds), b = await scanAccountPage("alldebrid", creds, a.nextCursor!);
    expect(a.items).toHaveLength(100); expect(b.items).toHaveLength(21); expect(b.nextCursor).toBeNull(); expect(new Set([...a.items, ...b.items].map(item => item.providerRef)).size).toBe(121); expect(calls).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(a)).not.toContain("private-link"); expect(JSON.stringify(a)).not.toContain(creds.apiKey);
  });
  it("scans the Premiumize cloud, including old nested files absent from transfer history", async () => {
    const nested = Array.from({ length: 101 }, (_, index) => ({ id: `video-${String(index).padStart(3, "0")}`, name: `Episode.S01E${index + 1}.mkv`, type: "file", link: "https://cdn.invalid/signed?token=private", size: 500 }));
    const calls = mock((url, init) => {
      expect(url.pathname).toBe("/api/folder/list"); expect(init.method ?? "GET").toBe("GET");
      return { status: "success", content: url.searchParams.get("id") === "Folder" ? [...nested, { id: "readme", name: "readme.nfo", type: "file" }] : [{ id: "Folder", name: "Existing collection", type: "folder" }, { id: "rootvideo", name: "Root.Movie.2024.mp4", type: "file", link: "https://cdn.invalid/root?token=secret" }] };
    });
    const first = await scanAccountPage("premiumize", creds), second = await scanAccountPage("premiumize", creds, first.nextCursor!);
    expect(first.items).toHaveLength(100); expect(second.items).toHaveLength(2); expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items].every(item => item.providerRef.startsWith("file:") && item.phase === "finished")).toBe(true);
    expect(JSON.stringify(first)).not.toContain("https:"); expect(JSON.stringify(first)).not.toContain("token="); expect(calls.mock.calls.every(call => !String(call[0]).includes("transfer"))).toBe(true);
  });
  it("durably continues bounded cloud traversal even on pages that contain no videos", async () => {
    const calls = mock(url => {
      const current = Number((url.searchParams.get("id") ?? "folder-0").split("-")[1]);
      return { status: "success", content: current < 10 ? [{ id: `folder-${current + 1}`, name: "Subfolder", type: "folder" }] : [{ id: "film", name: "Deep.Movie.2024.mkv", type: "file" }] };
    });
    let page = await scanAccountPage("premiumize", creds); expect(page.items).toHaveLength(0); expect(page.nextCursor).not.toBeNull(); expect(calls).toHaveBeenCalledTimes(6);
    const items = [...page.items]; let pages = 1;
    while (page.nextCursor) { const before = calls.mock.calls.length; page = await scanAccountPage("premiumize", creds, page.nextCursor); expect(calls.mock.calls.length - before).toBeLessThanOrEqual(6); items.push(...page.items); expect(++pages).toBeLessThan(10); }
    expect(items).toMatchObject([{ providerRef: "file:film", name: "Deep.Movie.2024.mkv" }]);
  });
  it("refuses cyclic cloud folder graphs instead of declaring a partial scan complete", async () => {
    mock(() => ({ status: "success", content: [{ id: "same-folder", name: "Cycle", type: "folder" }] }));
    await expect(scanAccountPage("premiumize", creds)).rejects.toMatchObject({ statusCode: 422 });
  });
  it("honors an existing administrator baseURL override while refusing redirects", async () => {
    const calls = mock((url, init) => { expect(url.origin).toBe("https://fixture.invalid"); expect(url.pathname).toBe("/custom/torrents"); expect(init.redirect).toBe("error"); return []; });
    await scanAccountPage("realdebrid", { ...creds, baseUrl: "https://fixture.invalid/custom/" }); expect(calls).toHaveBeenCalledTimes(1);
    await expect(scanAccountPage("realdebrid", { ...creds, baseUrl: "https://private:password@fixture.invalid/custom" })).rejects.toMatchObject({ statusCode: 503 }); expect(calls).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed account credentials without sending requests", async () => {
    const calls = mock(() => []);
    await expect(scanAccountPage("realdebrid", { apiKey: "" })).rejects.toBeInstanceOf(ProviderError);
    await expect(scanAccountPage("realdebrid", { apiKey: undefined as unknown as string })).rejects.toBeInstanceOf(ProviderError);
    await expect(scanAccountPage("realdebrid", { apiKey: "private\nkey" })).rejects.toBeInstanceOf(ProviderError);
    await expect(scanAccountPage("realdebrid", { apiKey: "private🔒key" })).rejects.toBeInstanceOf(ProviderError); expect(calls).not.toHaveBeenCalled();
  });
  it.each([[401, 401], [429, 429], [503, 503]])("sanitizes upstream HTTP %i errors", async (status, returned) => {
    mock(() => response({ error: `${creds.apiKey}: /private/data https://cdn.invalid/private` }, status));
    const caught = await scanAccountPage("realdebrid", creds).catch(error => error);
    expect(caught).toMatchObject({ statusCode: returned }); expect(caught.message).not.toContain(creds.apiKey); expect(caught.message).not.toContain("/private"); expect(caught.message).not.toContain("https:");
  });
  it("sanitizes native network and provider-envelope errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error(`https://api.invalid/?apikey=${creds.apiKey}`)));
    const caught = await scanAccountPage("alldebrid", creds).catch(error => error); expect(caught).toBeInstanceOf(ProviderError); expect(caught.message).not.toContain(creds.apiKey);
    mock(() => ({ status: "error", error: { message: creds.apiKey } })); const envelope = await scanAccountPage("alldebrid", creds).catch(error => error); expect(envelope.message).not.toContain(creds.apiKey);
    mock(() => ({ status: "error", error: { code: "AUTH_BAD_APIKEY", message: creds.apiKey } })); await expect(scanAccountPage("alldebrid", creds)).rejects.toMatchObject({ statusCode: 401 });
    mock(() => ({ status: "error", message: "Not logged in" })); await expect(scanAccountPage("premiumize", creds)).rejects.toMatchObject({ statusCode: 401 });
  });
  it("caps response bodies and oversized unpaginated provider lists", async () => {
    mock(() => response([], 200, { "content-length": String(9 * 1024 * 1024) })); await expect(scanAccountPage("realdebrid", creds)).rejects.toMatchObject({ statusCode: 502 });
    mock(() => new Response(" ".repeat(8 * 1024 * 1024 + 1))); await expect(scanAccountPage("realdebrid", creds)).rejects.toMatchObject({ statusCode: 502 });
    mock(() => ({ status: "success", data: { magnets: Array.from({ length: 10001 }, (_, index) => ad(index)) } })); await expect(scanAccountPage("alldebrid", creds)).rejects.toMatchObject({ statusCode: 502 });
  });
  it("keeps body-reading under the request timeout and honors an expired operation deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url, init: RequestInit) => Promise.resolve(new Response(new ReadableStream({ start(stream) { init.signal!.addEventListener("abort", () => stream.error(new Error("private timeout"))); } })))));
    const check = expect(scanAccountPage("realdebrid", { ...creds, timeoutMs: 50 })).rejects.toMatchObject({ statusCode: 504 }); await vi.advanceTimersByTimeAsync(51); await check;
    const expired = { ...creds, deadline: Date.now() - 1 }; await expect(scanAccountPage("realdebrid", expired)).rejects.toMatchObject({ statusCode: 504 }); expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("play existing account references", () => {
  it("returns opaque RD video choices, rematches selected-only links and tolerates signed-link rotation", async () => {
    let info = 0; const calls = mock((url, init) => {
      if (url.pathname.includes("/torrents/info/")) { const suffix = info++ ? "-new" : ""; return videoStatus("torrent-a", { files: [{ id: 1, path: "/Show.S01E01.mkv", bytes: 400, selected: 1 }, { id: 2, path: "/readme.nfo", selected: 1 }, { id: 3, path: "/Show.S01E02.mp4", bytes: 500, selected: 1 }, { id: 4, path: "/unselected.mkv", selected: 0 }], links: [`https://hoster.invalid/one${suffix}`, "https://hoster.invalid/readme", `https://hoster.invalid/two${suffix}`] }); }
      expect(url.pathname).toBe("/rest/1.0/unrestrict/link"); expect(init.method).toBe("POST"); expect((init.body as URLSearchParams).get("link")).toBe("https://hoster.invalid/two-new"); return { download: "https://cdn.invalid/signed?expires=soon", filename: "Show.S01E02.mp4", filesize: 500, mimeType: "video/mp4" };
    });
    const choices = await playAccountItem("realdebrid", creds, "torrent-a"); expect(choices.selectionRequired).toBe(true); expect(choices.files).toHaveLength(2); expect(choices.files!.every(file => /^[a-f0-9]{64}$/.test(file.token))).toBe(true); expect(JSON.stringify(choices)).not.toContain("https:");
    const played = await playAccountItem("realdebrid", creds, "torrent-a", choices.files![1].token); expect(played.stream).toMatchObject({ provider: "realdebrid", url: "https://cdn.invalid/signed?expires=soon", filename: "Show.S01E02.mp4", filesize: 500 }); expect(calls).toHaveBeenCalledTimes(3);
    expect(calls.mock.calls.every(call => !/addMagnet|selectFiles|delete/i.test(String(call[0])))).toBe(true);
  });
  it("reports waiting_files_selection as pending without mutating the account", async () => {
    const calls = mock(() => rd("waiting", { status: "waiting_files_selection", progress: 0, links: [] }));
    expect(await playAccountItem("realdebrid", creds, "waiting")).toEqual({ pending: true, progress: 0 }); expect(calls).toHaveBeenCalledTimes(1); expect(String(calls.mock.calls[0][0])).toContain("torrents/info/waiting");
  });
  it("refuses contradictory RD link mappings and nonvideo-only files", async () => {
    mock(() => videoStatus("torrent-a", { links: [] })); await expect(playAccountItem("realdebrid", creds, "torrent-a")).rejects.toMatchObject({ statusCode: 409 });
    mock(() => videoStatus("torrent-a", { files: [{ id: 1, path: "/archive.zip", selected: 1 }] })); await expect(playAccountItem("realdebrid", creds, "torrent-a")).rejects.toMatchObject({ statusCode: 422 });
  });
  it("selects the sole main video instead of a sample or nfo", async () => {
    const calls = mock(url => url.pathname.includes("/torrents/info/") ? videoStatus("torrent-a", { files: [{ id: 1, path: "/main.mkv", bytes: 1000, selected: 1 }, { id: 2, path: "/sample.mkv", selected: 1 }, { id: 3, path: "/readme.nfo", selected: 1 }], links: ["https://hoster.invalid/main", "https://hoster.invalid/sample", "https://hoster.invalid/readme"] }) : { download: "https://cdn.invalid/main" });
    expect((await playAccountItem("realdebrid", creds, "torrent-a")).stream).toMatchObject({ filename: "main.mkv", filesize: 1000 }); expect((calls.mock.calls[1][1].body as URLSearchParams).get("link")).toBe("https://hoster.invalid/main");
  });
  it("binds file tokens to the existing reference and account key", async () => {
    mock(url => videoStatus(url.pathname.split("/").pop(), { files: [{ id: 1, path: "/one.mkv", selected: 1 }, { id: 2, path: "/two.mkv", selected: 1 }], links: ["https://hoster.invalid/one", "https://hoster.invalid/two"] }));
    const choice = (await playAccountItem("realdebrid", creds, "torrent-a")).files![0].token;
    await expect(playAccountItem("realdebrid", creds, "torrent-b", choice)).rejects.toMatchObject({ statusCode: 409 });
    await expect(playAccountItem("realdebrid", { apiKey: "another-private-key" }, "torrent-a", choice)).rejects.toMatchObject({ statusCode: 409 });
  });
  it("reads AllDebrid's existing nested file tree and unlocks only the chosen video", async () => {
    const calls = mock((url, init) => {
      if (url.pathname.endsWith("/magnet/status")) return { status: "success", data: { magnets: ad(7) } };
      if (url.pathname.endsWith("/magnet/files")) { expect(init.method).toBe("POST"); expect((init.body as URLSearchParams).get("id[]")).toBe("7"); return { status: "success", data: { magnets: [{ id: 7, files: [{ n: "Season", e: [{ n: "Show.S01E01.mkv", s: 123, l: "https://hoster.invalid/first" }, { n: "readme.nfo", l: "https://hoster.invalid/nfo" }, { n: "Show.S01E02.mkv", l: "https://hoster.invalid/second" }] }] }] } }; }
      expect(url.pathname).toBe("/v4/link/unlock"); expect(url.searchParams.get("link")).toBe("https://hoster.invalid/first"); return { status: "success", data: { link: "https://cdn.invalid/first", filename: "Show.S01E01.mkv", filesize: 123 } };
    });
    const choices = await playAccountItem("alldebrid", creds, "7"); expect(choices.files).toHaveLength(2); expect(choices.files![0].name).toBe("Season/Show.S01E01.mkv");
    expect((await playAccountItem("alldebrid", creds, "7", choices.files![0].token)).stream).toMatchObject({ provider: "alldebrid", url: "https://cdn.invalid/first" }); expect(calls).toHaveBeenCalledTimes(5);
    expect(calls.mock.calls.every(call => !/upload|restart|delete/i.test(String(call[0])))).toBe(true);
  });
  it("does not fetch file trees or unlock links until AllDebrid reports readiness", async () => {
    const calls = mock(() => ({ status: "success", data: { magnets: ad(7, { statusCode: 1, downloaded: 42, size: 100 }) } }));
    expect(await playAccountItem("alldebrid", creds, "7")).toEqual({ pending: true, progress: 42 }); expect(calls).toHaveBeenCalledTimes(1);
  });
  it("plays Premiumize cloud files directly without transfer creation or re-unrestriction", async () => {
    const calls = mock((url, init) => { expect(url.pathname).toBe("/api/item/details"); expect(url.searchParams.get("id")).toBe("cloud-file"); expect(init.method ?? "GET").toBe("GET"); return { status: "success", id: "cloud-file", name: "Existing.Movie.2024.mkv", link: "https://cdn.invalid/original?signature=ephemeral", size: 2048, stream_link: "https://wrong.invalid/deprecated" }; });
    expect((await playAccountItem("premiumize", creds, "file:cloud-file")).stream).toEqual({ provider: "premiumize", filename: "Existing.Movie.2024.mkv", url: "https://cdn.invalid/original?signature=ephemeral", filesize: 2048 }); expect(calls).toHaveBeenCalledTimes(1);
  });
  it("rejects stale account references and unusable provider stream schemes", async () => {
    const calls = mock(() => ({ status: "success", id: "cloud-file", name: "File.mkv", link: "javascript:alert(1)" }));
    await expect(playAccountItem("premiumize", creds, "file:cloud-file")).rejects.toMatchObject({ statusCode: 422 });
    await expect(playAccountItem("premiumize", creds, "https://private.invalid/ref")).rejects.toMatchObject({ statusCode: 400 }); expect(calls).toHaveBeenCalledTimes(1);
  });
  it("does not mark a provider error phase as pending or playable", async () => {
    mock(() => rd("failed", { status: "error" })); await expect(playAccountItem("realdebrid", creds, "failed")).rejects.toMatchObject({ statusCode: 422 });
  });
});

if ((PROVIDER_IDS as readonly string[]).includes("torbox")) {
  const provider = "torbox" as ProviderId;
  describe("Torbox existing-account import and playback", () => {
    it("locally pages existing torrents and omits raw file/link objects", async () => {
      const calls = mock((url, init) => { expect(url.pathname).toBe("/v1/api/torrents/mylist"); expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${creds.apiKey}`); return { success: true, data: Array.from({ length: 121 }, (_, index) => tb(index + 1, { files: [{ id: 1, link: "https://cdn.invalid/private" }] })) }; });
      const first = await scanAccountPage(provider, creds), second = await scanAccountPage(provider, creds, first.nextCursor!); expect(first.items).toHaveLength(100); expect(second.items).toHaveLength(21); expect(second.nextCursor).toBeNull(); expect(calls).toHaveBeenCalledTimes(2); expect(JSON.stringify(first)).not.toContain("https:");
    });
    it("resolves only the chosen existing pseudo reference with requestdl", async () => {
      const calls = mock(url => {
        if (url.pathname.endsWith("/mylist")) return { success: true, data: tb(5, { files: [{ id: 10, name: "Show.S01E01.mkv", size: 100 }, { id: 11, name: "readme.nfo" }, { id: 12, name: "Show.S01E02.mp4", size: 200 }] }) };
        expect(url.pathname).toBe("/v1/api/torrents/requestdl"); expect(url.searchParams.get("torrent_id")).toBe("5"); expect(url.searchParams.get("file_id")).toBe("12"); expect(url.searchParams.get("token")).toBe(creds.apiKey); expect(url.searchParams.get("redirect")).toBe("false"); return { success: true, data: "https://cdn.invalid/episode2?signature=private" };
      });
      const choices = await playAccountItem(provider, creds, "5"); expect(choices.files).toHaveLength(2);
      expect((await playAccountItem(provider, creds, "5", choices.files![1].token)).stream).toMatchObject({ provider, filename: "Show.S01E02.mp4", filesize: 200, url: "https://cdn.invalid/episode2?signature=private" }); expect(calls).toHaveBeenCalledTimes(3);
      expect(calls.mock.calls.every(call => !/create|webdl|controltorrent/i.test(String(call[0])))).toBe(true);
    });
    it("keeps an unfinished download pending even at 100percent progress", async () => {
      mock(() => ({ success: true, data: [tb(5, { download_state: "downloading", download_finished: false, progress: 1 })] }));
      expect(await playAccountItem(provider, creds, "5")).toEqual({ pending: true, progress: 100 });
    });
    it("does not treat a failed download as ready due to a stale finished flag", async () => {
      mock(() => ({ success: true, data: tb(5, { download_state: "failed", download_finished: true }) }));
      await expect(playAccountItem(provider, creds, "5")).rejects.toMatchObject({ statusCode: 422 });
    });
  });
}
