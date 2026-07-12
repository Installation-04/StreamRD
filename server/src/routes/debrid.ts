import { Router } from "express";
import { requireAuth } from "../auth/middleware";
import { db } from "../db";
import { debridManager } from "../providers/manager";
import { PROVIDER_IDS, ProviderError, ProviderId } from "../providers/types";

export const debridRouter = Router();
debridRouter.use(requireAuth);

/**
 * GET /api/debrid/account?provider=realdebrid
 * Live account info from the user's primary (or a chosen) provider.
 * Doubles as the "Test connection" action in all clients.
 */
debridRouter.get("/account", async (req, res) => {
  const cfg = await db.debridConfig.findUnique({ where: { userId: req.session!.sub } });
  if (!cfg) {
    res.status(404).json({ error: "No debrid configuration yet" });
    return;
  }
  const q = req.query.provider as string | undefined;
  const provider =
    q && PROVIDER_IDS.includes(q as ProviderId) ? (q as ProviderId) : undefined;
  try {
    const info = await debridManager.getUserInfo(cfg, provider);
    res.json({ account: info });
  } catch (err) {
    const status = err instanceof ProviderError && err.statusCode === 401 ? 401 : 502;
    res.status(status).json({ error: (err as Error).message });
  }
});
