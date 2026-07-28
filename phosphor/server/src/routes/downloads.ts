import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { db } from "../db";
import { logEvent } from "../logger";
import { debridManager } from "../providers/manager";
import { getProvider } from "../providers/registry";
import { PROVIDER_IDS, ProviderId } from "../providers/types";
import { parseBody } from "./helpers";

export const downloadsRouter = Router();
downloadsRouter.use(requireAuth);

downloadsRouter.get("/", async (req, res) => {
  const jobs = await db.downloadJob.findMany({
    where: { userId: req.session!.sub },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  res.json({ jobs });
});

downloadsRouter.get("/:id", async (req, res) => {
  const job = await db.downloadJob.findFirst({ where: { id: req.params.id, userId: req.session!.sub } });
  if (!job) {
    res.status(404).json({ error: "Download job not found" });
    return;
  }
  res.json({ job });
});

const createSchema = z.object({
  title: z.string().min(1),
  sourceUrl: z.string().min(1),
  provider: z.enum(PROVIDER_IDS).optional(),
  sizeBytes: z.number().int().min(0).optional(),
  seeders: z.number().int().min(0).optional(),
  indexerName: z.string().optional(),
});

/**
 * POST /api/downloads — add a magnet (queued on the provider, polled via
 * /refresh) or a direct hoster link (unrestricted immediately) to the
 * user's download queue.
 */
downloadsRouter.post("/", async (req, res) => {
  const body = parseBody(createSchema, req.body, res);
  if (!body) return;
  const userId = req.session!.sub;
  const cfg = await db.debridConfig.upsert({ where: { userId }, create: { userId }, update: {} });
  const providerId = (body.provider ?? cfg.primaryProvider) as ProviderId;
  const creds = await debridManager.credentialsFor(cfg, providerId).catch((err: Error) => {
    res.status(400).json({ error: err.message });
    return null;
  });
  if (!creds) return;
  const provider = getProvider(providerId);

  const base = {
    userId,
    title: body.title,
    sourceUrl: body.sourceUrl,
    sizeBytes: body.sizeBytes ?? 0,
    seeders: body.seeders ?? 0,
    indexerName: body.indexerName,
    provider: providerId,
  };

  try {
    if (body.sourceUrl.startsWith("magnet:")) {
      const status = await provider.addTorrent(creds, body.sourceUrl);
      let streamUrl: string | undefined;
      let filename: string | undefined;
      if (status.phase === "finished" && status.links.length > 0) {
        try {
          const link = await provider.unrestrictLink(creds, status.links[0]);
          streamUrl = link.url;
          filename = link.filename;
        } catch {
          /* leave unresolved; the client can retry via /refresh */
        }
      }
      const job = await db.downloadJob.create({
        data: {
          ...base,
          providerRef: status.id,
          status: streamUrl ? "finished" : status.phase,
          progress: status.progress,
          streamUrl,
          filename,
        },
      });
      await logEvent("info", "download", `Added "${body.title}" via ${providerId}`, { userId, provider: providerId });
      res.status(201).json({ job });
    } else {
      const link = await provider.unrestrictLink(creds, body.sourceUrl);
      const job = await db.downloadJob.create({
        data: { ...base, status: "finished", progress: 100, streamUrl: link.url, filename: link.filename },
      });
      await logEvent("info", "download", `Unrestricted "${body.title}" via ${providerId}`, { userId, provider: providerId });
      res.status(201).json({ job });
    }
  } catch (err) {
    const job = await db.downloadJob.create({
      data: { ...base, status: "error", error: (err as Error).message },
    });
    await logEvent("error", "provider_error", `Download failed for "${body.title}": ${(err as Error).message}`, {
      userId,
      provider: providerId,
    });
    res.status(502).json({ job, error: (err as Error).message });
  }
});

/** POST /api/downloads/:id/refresh — poll the provider for a still-active job. */
downloadsRouter.post("/:id/refresh", async (req, res) => {
  const job = await db.downloadJob.findFirst({ where: { id: req.params.id, userId: req.session!.sub } });
  if (!job) {
    res.status(404).json({ error: "Download job not found" });
    return;
  }
  if (job.status === "finished" || job.status === "error" || !job.providerRef) {
    res.json({ job });
    return;
  }
  const cfg = await db.debridConfig.findUnique({ where: { userId: req.session!.sub } });
  if (!cfg) {
    res.status(400).json({ error: "No debrid configuration" });
    return;
  }
  try {
    const { status, stream } = await debridManager.refresh(cfg, job.provider as ProviderId, job.providerRef);
    const updated = await db.downloadJob.update({
      where: { id: job.id },
      data: {
        status: stream ? "finished" : status.phase,
        progress: status.progress,
        streamUrl: stream?.url ?? job.streamUrl,
        filename: stream?.filename ?? job.filename,
      },
    });
    res.json({ job: updated });
  } catch (err) {
    const updated = await db.downloadJob.update({
      where: { id: job.id },
      data: { status: "error", error: (err as Error).message },
    });
    res.status(502).json({ job: updated, error: (err as Error).message });
  }
});

/**
 * DELETE /api/downloads/clear-completed — bulk-remove every finished/errored
 * job in one query, instead of the client firing N individual deletes.
 * Registered before the `/:id` route below so it isn't swallowed as an id.
 */
downloadsRouter.delete("/clear-completed", async (req, res) => {
  const { count } = await db.downloadJob.deleteMany({
    where: { userId: req.session!.sub, status: { in: ["finished", "error"] } },
  });
  res.json({ removed: count });
});

downloadsRouter.delete("/:id", async (req, res) => {
  const job = await db.downloadJob.findFirst({ where: { id: req.params.id, userId: req.session!.sub } });
  if (!job) {
    res.status(404).json({ error: "Download job not found" });
    return;
  }
  await db.downloadJob.delete({ where: { id: job.id } });
  res.json({ ok: true });
});
