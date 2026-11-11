import { asyncHandler } from "../http";
import { Router } from "express";
import { requireAuth } from "../auth/middleware";
import { db } from "../db";
import { debridManager } from "../providers/manager";
import { getProvider } from "../providers/registry";
import { PROVIDER_IDS, ProviderError, ProviderId } from "../providers/types";
import { logEvent } from "../logger";

export const debridRouter = Router();
debridRouter.use(requireAuth);

/**
 * GET /api/debrid/account?provider=realdebrid
 * Live account info from the user's primary (or a chosen) provider.
 * Doubles as the "Test connection" action in all clients.
 */
debridRouter.get("/account", asyncHandler(async (req, res) => {
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
    const failure = explain(provider ?? (PROVIDER_IDS.includes(cfg.primaryProvider as ProviderId) ? cfg.primaryProvider as ProviderId : undefined), err);
    void logEvent("warn", "provider_error", `Connection test failed: ${failure.error}`, { userId: req.session!.sub, provider: provider ?? cfg.primaryProvider }).catch(() => undefined);
    res.status(failure.status).json({ error: failure.error });
  }
}));

/**
 * Why a connection test failed, in words the person at the settings page can act on. The provider's own text is not passed on: it is a
 * code ("bad_token") at best. A refused key is 409, never 401: 401 from this API means the viewer's own session ended.
 */
function explain(provider: ProviderId | undefined, err: unknown): { status: number; error: string } {
  let name = "The provider";
  try { if (provider) name = getProvider(provider).displayName; } catch { /* keep the general name */ }
  const code = err instanceof ProviderError ? err.statusCode : undefined, text = err instanceof Error ? err.message : "";
  if (code === 401 || code === 403) return { status: 409, error: `${name} did not accept this key. Copy it again from your ${name} account, save, and test again.` };
  if (code === 429) return { status: 429, error: `${name} is limiting requests from this server. Wait a minute and test again.` };
  if (/timed out|deadline/i.test(text)) return { status: 504, error: `${name} did not answer in time. Check the server's internet connection and test again.` };
  if (/no .*key|not configured|missing/i.test(text)) return { status: 409, error: `No key is saved for ${name}. Enter it, save, and test again.` };
  return { status: 502, error: `${name} could not be reached or answered with an error${code ? ` (${code})` : ""}. Try again in a moment.` };
}
