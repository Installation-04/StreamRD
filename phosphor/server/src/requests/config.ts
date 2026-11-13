import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { db } from "../db";
import { decryptSecret, encryptSecret } from "../crypto";
import { requireAuth, requireAdmin } from "../auth/middleware";
import { asyncHandler } from "../http";
import { parseBody } from "../routes/helpers";
import { rateLimit } from "../util/rateLimit";
import { normalizeQbitUrl, QbitClient, QbitSettings, RequestClientError } from "./clients";

const KEY = "requests.qbit";
const empty = (): QbitSettings => ({ enabled: false, baseUrl: "", username: "", password: "", ownerId: "", shareWithAddons: false });
const storedSchema = z.object({ enabled: z.boolean(), baseUrl: z.string().max(2048), username: z.string().max(200), password: z.string().max(1500), ownerId: z.string(), shareWithAddons: z.boolean().default(false) });
/** The password is stored encrypted (see crypto.ts); callers always see it in clear. */
const readStored = (value: string | undefined): QbitSettings => { const stored = storedSchema.parse(JSON.parse(value ?? "null")); return { ...stored, password: decryptSecret(stored.password) ?? "" }; };
const serialize = (value: QbitSettings): string => JSON.stringify({ ...value, password: encryptSecret(value.password) });
type SettingsDb = Pick<Prisma.TransactionClient, "setting" | "user">;
export async function getRequestSettings(client: SettingsDb = db): Promise<{ qbit: QbitSettings }> {
  const row = await client.setting.findUnique({ where: { key: KEY } });
  try { return { qbit: readStored(row?.value) }; } catch { return { qbit: empty() }; }
}
export async function qbitContext(userId: string, client: SettingsDb = db) {
  const [{ qbit }, user] = await Promise.all([getRequestSettings(client), client.user.findFirst({ where: { id: userId, active: true, role: "admin" }, select: { id: true } })]);
  if (!user || qbit.ownerId !== userId || !qbit.enabled || !qbit.baseUrl || !qbit.username || !qbit.password) throw new RequestClientError("Configure and enable your qBittorrent connection before approving local downloads.");
  normalizeQbitUrl(qbit.baseUrl);
  // Sharing is not part of a request's credentials. Preserve the historical
  // fingerprint so this defaulted setting cannot orphan existing transfers.
  const { shareWithAddons: _sharing, ...requestSettings } = qbit;
  return { settings: qbit, fingerprint: createHash("sha256").update(JSON.stringify(requestSettings)).digest("hex") };
}
function publicSettings(qbit: QbitSettings, viewerId: string, canReset = qbit.ownerId === viewerId) {
  const ownedByYou = qbit.ownerId === viewerId;
  return { qbit: { enabled: qbit.enabled, baseUrl: ownedByYou ? qbit.baseUrl : "", username: ownedByYou ? qbit.username : "", passwordConfigured: Boolean(qbit.password), shareWithAddons: ownedByYou && Boolean(qbit.shareWithAddons), ownedByYou, canReset } };
}
export const requestSettingsRouter = Router();
requestSettingsRouter.use(requireAuth, requireAdmin, (_req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); next(); });
const limit = rateLimit({ windowMs: 60_000, max: 30 });
requestSettingsRouter.get("/", asyncHandler(async (req, res) => {
  const { qbit } = await getRequestSettings();
  const liveOwner = qbit.ownerId ? await db.user.findFirst({ where: { id: qbit.ownerId, active: true, role: "admin" }, select: { id: true } }) : null;
  res.json({ settings: publicSettings(qbit, req.session!.sub, Boolean(qbit.ownerId && (!liveOwner || qbit.ownerId === req.session!.sub))) });
}));
requestSettingsRouter.put("/", limit, asyncHandler(async (req, res) => {
  const body = parseBody(z.object({ qbit: z.object({ enabled: z.boolean().optional(), baseUrl: z.string().trim().max(2048).optional(), username: z.string().trim().max(200).optional(), password: z.string().max(500).optional(), clearPassword: z.boolean().optional(), shareWithAddons: z.boolean().optional() }).strict() }).strict(), req.body, res);
  if (!body) return;
  try {
    const saved = await db.$transaction(async tx => {
      await tx.setting.upsert({ where: { key: "requests.settings.lock" }, create: { key: "requests.settings.lock", value: "1" }, update: { value: "1" } });
      const actor = await tx.user.findFirst({ where: { id: req.session!.sub, active: true, role: "admin", sessionVersion: req.session!.version, revokedSessions: { none: { id: req.session!.jti } } }, select: { id: true } });
      if (!actor || req.session!.exp * 1000 <= Date.now()) throw new RequestClientError("Your administrator session is no longer active.", 401);
      const row = await tx.setting.findUnique({ where: { key: KEY } });
      let current = empty();
      try { current = readStored(row?.value); } catch { /* malformed configuration stays disabled */ }
      if (current.ownerId && current.ownerId !== actor.id) throw new RequestClientError("This qBittorrent connection belongs to another administrator.");
      const input = body.qbit;
      const value: QbitSettings = { ...current, enabled: input.enabled ?? current.enabled, baseUrl: input.baseUrl === undefined ? current.baseUrl : input.baseUrl ? normalizeQbitUrl(input.baseUrl) : "", username: input.username ?? current.username, password: input.clearPassword ? "" : input.password || current.password, ownerId: actor.id, shareWithAddons: input.shareWithAddons ?? current.shareWithAddons ?? false };
      if (input.clearPassword) value.enabled = false;
      if (value.enabled && (!value.baseUrl || !value.username || !value.password)) throw new RequestClientError("A URL, username and password are required to enable qBittorrent.", 400);
      if (!value.password || !value.baseUrl) value.enabled = false;
      await tx.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: serialize(value) }, update: { value: serialize(value) } });
      return value;
    }, { maxWait: 10000, timeout: 10000 });
    res.json({ settings: publicSettings(saved, req.session!.sub) });
  } catch (error) { if (error instanceof RequestClientError) { res.status(error.status).json({ error: error.message }); return; } throw error; }
}));
requestSettingsRouter.post("/test", limit, asyncHandler(async (req, res) => {
  try {
    const ctx = await qbitContext(req.session!.sub), client = new QbitClient(ctx.settings); await client.login();
    const fresh = await qbitContext(req.session!.sub);
    const actor = await db.user.findFirst({ where: { id: req.session!.sub, active: true, role: "admin", sessionVersion: req.session!.version, revokedSessions: { none: { id: req.session!.jti } } }, select: { id: true } });
    if (!actor || req.session!.exp * 1000 <= Date.now() || fresh.fingerprint !== ctx.fingerprint) throw new RequestClientError("The connection or session changed while testing. Refresh and retry.");
    res.json({ ok: true });
  } catch (error) { if (error instanceof RequestClientError) { res.status(error.status).json({ error: error.message }); return; } res.status(503).json({ error: "Could not test qBittorrent. Check its connection and saved credentials." }); }
}));

requestSettingsRouter.post("/reset", limit, asyncHandler(async (req, res) => {
  try {
    const value = await db.$transaction(async tx => {
      await tx.setting.upsert({ where: { key: "requests.settings.lock" }, create: { key: "requests.settings.lock", value: "1" }, update: { value: "1" } });
      const actor = await tx.user.findFirst({ where: { id: req.session!.sub, active: true, role: "admin", sessionVersion: req.session!.version, revokedSessions: { none: { id: req.session!.jti } } }, select: { id: true } });
      if (!actor || req.session!.exp * 1000 <= Date.now()) throw new RequestClientError("Your administrator session is no longer active.", 401);
      const { qbit } = await getRequestSettings(tx);
      const owner = qbit.ownerId ? await tx.user.findFirst({ where: { id: qbit.ownerId, active: true, role: "admin" }, select: { id: true } }) : null;
      if (owner && qbit.ownerId !== actor.id) throw new RequestClientError("This qBittorrent connection belongs to another active administrator.");
      const reset = { ...empty(), ownerId: actor.id };
      await tx.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(reset) }, update: { value: JSON.stringify(reset) } });
      return reset;
    });
    res.json({ settings: publicSettings(value, req.session!.sub) });
  } catch (error) { if (error instanceof RequestClientError) { res.status(error.status).json({ error: error.message }); return; } throw error; }
}));
