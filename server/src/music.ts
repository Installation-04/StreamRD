import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "./auth/middleware";
import { asyncHandler } from "./http";
import { logEvent } from "./logger";
import { assertRequestActor, RequestError } from "./requests/media";
import { rateLimit } from "./util/rateLimit";
import { call, connection } from "./addon-links";
import { parseBody } from "./routes/helpers";

/**
 * Music search and requests, through the Lidarr that StreamRD runs from Admin → Add-ons. Lidarr looks albums up in its own catalogue (no
 * account needed) and, once an album is asked for, monitors it and searches the indexers shared with it by Prowlarr; the downloads go to the
 * qBittorrent it is linked to. Nothing is kept here: where an album stands is read back from Lidarr each time.
 */
export const musicRouter = Router();
musicRouter.use(requireAuth, (_req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); next(); });
const lookupLimit = rateLimit({ windowMs: 60_000, max: 60 }), mutationLimit = rateLimit({ windowMs: 60_000, max: 20 });

interface LidarrAlbum {
  id?: number; title?: string; foreignAlbumId?: string; releaseDate?: string; albumType?: string; monitored?: boolean;
  images?: Array<{ coverType?: string; remoteUrl?: string; url?: string }>;
  artist?: { artistName?: string; foreignArtistId?: string };
  statistics?: { trackFileCount?: number; totalTrackCount?: number; percentOfTracks?: number };
}
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Standing = "available" | "requested" | null;
/** Already in the library and complete, or asked for and being looked for, or neither. */
function standing(album: LidarrAlbum): Standing {
  if (!album.id) return null;
  if ((album.statistics?.percentOfTracks ?? 0) >= 100) return "available";
  return album.monitored ? "requested" : null;
}
function cover(album: LidarrAlbum): string | null {
  const image = album.images?.find(one => one.coverType === "cover") ?? album.images?.[0], url = image?.remoteUrl || image?.url || "";
  try { const parsed = new URL(url); return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null; } catch { return null; }
}
function view(album: LidarrAlbum) {
  return { id: String(album.foreignAlbumId ?? ""), title: String(album.title ?? "").slice(0, 200), artist: String(album.artist?.artistName ?? "").slice(0, 200),
    year: /^\d{4}/.test(album.releaseDate ?? "") ? Number(album.releaseDate!.slice(0, 4)) : null, kind: String(album.albumType ?? "").slice(0, 40), coverUrl: cover(album), status: standing(album) };
}
const action = (run: Parameters<typeof asyncHandler>[0]) => asyncHandler(async (req, res, next) => {
  try { await run(req, res, next); }
  catch (error) { if (error instanceof RequestError) { res.status(error.status).json({ error: error.message }); return; } throw error; }
});
const unavailable = () => new RequestError("Music needs Lidarr. An administrator can install it from Admin → Add-ons.", 409);

/** Whether music can be searched right now, so the page shows the option only when it works. */
musicRouter.get("/status", lookupLimit, action(async (_req, res) => { res.json({ available: Boolean(await connection("lidarr")) }); }));
musicRouter.get("/search", lookupLimit, action(async (req, res) => {
  const query = parseBody(z.object({ q: z.string().trim().min(2).max(200) }).strict(), req.query, res); if (!query) return;
  await assertRequestActor(req.session!);
  const lidarr = await connection("lidarr"); if (!lidarr) throw unavailable();
  let found: LidarrAlbum[];
  try { found = await call<LidarrAlbum[]>(lidarr.base, "lidarr", lidarr.key, "GET", `/album/lookup?term=${encodeURIComponent(query.q)}`); }
  catch { throw new RequestError("Lidarr could not search just now. Its catalogue service may be unreachable; try again in a minute.", 502); }
  res.json({ results: (Array.isArray(found) ? found : []).filter(album => MBID.test(album.foreignAlbumId ?? "")).slice(0, 24).map(view) });
}));
/** Asks for one album: it is added to Lidarr (with its artist, unmonitored apart from this album), monitored, and searched for. */
musicRouter.post("/request", mutationLimit, action(async (req, res) => {
  const body = parseBody(z.object({ id: z.string().regex(MBID) }).strict(), req.body, res); if (!body) return;
  await assertRequestActor(req.session!);
  const lidarr = await connection("lidarr"); if (!lidarr) throw unavailable();
  const lookup = (route: string, method = "GET", payload?: unknown) => call<any>(lidarr.base, "lidarr", lidarr.key, method, route, payload);   // eslint-disable-line @typescript-eslint/no-explicit-any
  const found = await lookup(`/album/lookup?term=${encodeURIComponent(`lidarr:${body.id}`)}`).catch(() => null) as LidarrAlbum[] | null;
  const album = Array.isArray(found) ? found.find(one => one.foreignAlbumId === body.id) : undefined;
  if (!album) throw new RequestError("Lidarr does not know that album.", 404);
  let albumId = album.id ?? 0;
  if (albumId) {
    const current = await lookup(`/album/${albumId}`) as LidarrAlbum; if (standing(current) === "available") { res.json({ status: "available" satisfies Standing }); return; }
    await lookup(`/album/${albumId}`, "PUT", { ...current, monitored: true });
  } else {
    const [quality, metadata, roots] = await Promise.all([lookup("/qualityprofile") as Promise<Array<{ id: number }>>, lookup("/metadataprofile") as Promise<Array<{ id: number }>>, lookup("/rootfolder") as Promise<Array<{ path: string }>>]);
    if (!quality[0] || !metadata[0] || !roots[0]) throw new RequestError("Lidarr is still setting itself up (no root folder yet). Try again in a minute or two.", 409);
    const added = await lookup("/album", "POST", { ...album, monitored: true, anyReleaseOk: true, addOptions: { searchForNewAlbum: true },
      artist: { ...album.artist, qualityProfileId: quality[0].id, metadataProfileId: metadata[0].id, rootFolderPath: roots[0].path, monitored: true, monitorNewItems: "none", addOptions: { monitor: "none", searchForMissingAlbums: false } } }) as LidarrAlbum;
    albumId = added.id ?? 0;
  }
  if (albumId) await lookup("/command", "POST", { name: "AlbumSearch", albumIds: [albumId] }).catch(() => undefined);   // adding already searches; this covers an album that was only known
  void logEvent("info", "admin_action", `Music requested: ${String(album.artist?.artistName ?? "").slice(0, 80)} — ${String(album.title ?? "").slice(0, 80)}`, { userId: req.session!.sub }).catch(() => undefined);
  res.status(202).json({ status: "requested" satisfies Standing });
}));
