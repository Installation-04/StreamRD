import { Router } from "express";
import { db } from "../db";

export const healthRouter = Router();

/** GET /api/health — public liveness probe for reverse proxies, Docker healthchecks, and every client's "test connection" button. */
healthRouter.get("/", async (_req, res) => {
  let dbOk = true;
  try {
    await db.$queryRaw`SELECT 1`;
  } catch {
    dbOk = false;
  }
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? "ok" : "degraded",
    db: dbOk ? "up" : "down",
    version: "0.1.0",
    time: new Date().toISOString(),
  });
});
