import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetDb } from "./helpers";
import { forgetNeighbour, listIndexers } from "../src/requests/finder";

// A Zilean installed from the Add-ons page has no ZILEAN_URL: StreamRD finds it by its name on the network, when Docker control is on.
const ENV = ["ZILEAN_URL", "DOCKER_CONTROL_STATE", "MEDIA_MANAGER_URL", "MEDIA_MANAGER_TOKEN"], kept: Record<string, string | undefined> = {};
beforeEach(async () => { for (const name of ENV) { kept[name] = process.env[name]; delete process.env[name]; } forgetNeighbour(); await resetDb(); });
afterEach(() => { for (const name of ENV) { if (kept[name] === undefined) delete process.env[name]; else process.env[name] = kept[name]; } vi.unstubAllGlobals(); forgetNeighbour(); });
const ids = async () => (await listIndexers()).map(indexer => indexer.id);

it("uses a Zilean that answers by name when Docker control is on, remembers the answer for a minute, and asks nothing when it is off", async () => {
  const fetcher = vi.fn(async () => new Response("pong", { status: 200 })); vi.stubGlobal("fetch", fetcher);
  expect(await ids()).toEqual([]); expect(fetcher).not.toHaveBeenCalled();   // Docker control is off: StreamRD did not put anything there
  process.env.DOCKER_CONTROL_STATE = "embedded"; process.env.MEDIA_MANAGER_URL = "http://127.0.0.1:9"; process.env.MEDIA_MANAGER_TOKEN = "m".repeat(40);
  expect(await ids()).toEqual(["zilean"]);
  expect(fetcher).toHaveBeenCalledTimes(1); expect(String(fetcher.mock.calls[0][0])).toBe("http://zilean:8181/healthchecks/ping");
  expect((await listIndexers())[0]).toMatchObject({ baseUrl: "http://zilean:8181/torznab/api", builtin: true });
  expect(await ids()).toEqual(["zilean"]); expect(fetcher).toHaveBeenCalledTimes(1);   // remembered
});

it("finds nothing when no Zilean answers, and lets ZILEAN_URL (the installer's way) win without asking", async () => {
  process.env.DOCKER_CONTROL_STATE = "embedded"; process.env.MEDIA_MANAGER_URL = "http://127.0.0.1:9"; process.env.MEDIA_MANAGER_TOKEN = "m".repeat(40);
  const refused = vi.fn(async () => { throw new Error("getaddrinfo ENOTFOUND zilean"); }); vi.stubGlobal("fetch", refused);
  expect(await ids()).toEqual([]);
  process.env.ZILEAN_URL = "http://zilean:8181"; forgetNeighbour(); refused.mockClear();
  expect(await ids()).toEqual(["zilean"]); expect(refused).not.toHaveBeenCalled();
});
