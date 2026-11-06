import { Router } from "express";
import { requireAuth } from "../auth/middleware";
import { config } from "../config";
import { db } from "../db";
import { asyncHandler } from "../http";
import { debridManager } from "../providers/manager";
import { PROVIDER_IDS } from "../providers/types";
import { getProviderSettings, getServerSettings } from "../settings";

export const setupRouter = Router();
setupRouter.use(requireAuth);

type Check = {
  id: string; title: string; description: string;
  status: "complete" | "action" | "optional"; required: boolean;
  href: string | null; actionLabel: string;
};

/** Read local configuration only. No provider/indexer requests or secret hints. */
setupRouter.get("/", asyncHandler(async (req, res) => {
  const userId = req.session!.sub, admin = req.session!.role === "admin";
  const [credentials, server, providerSettings] = await Promise.all([
    db.debridConfig.findUnique({ where: { userId } }), getServerSettings(), getProviderSettings(),
  ]);
  const availableOrder = credentials ? await debridManager.providerOrderFor(credentials, server) : [];
  const keys = credentials ? {
    realdebrid: credentials.realDebridToken, alldebrid: credentials.allDebridApiKey,
    premiumize: credentials.premiumizeApiKey, torbox: credentials.torboxApiKey,
  } : null;
  const providers = PROVIDER_IDS.map(id => ({
    id, configured: Boolean(keys?.[id]?.trim()),
    enabled: !server.disabledProviders.includes(id) && providerSettings[id]?.enabled !== false,
    eligible: availableOrder.includes(id) && Boolean(keys?.[id]?.trim()),
    verification: "not-tested" as const,
  }));
  const providerReady = providers.some(p => p.eligible);
  const checks: Check[] = [{
    id: "account", title: "Your account", required: true, status: "complete",
    description: "You are signed in. Your provider credentials and preferences belong to this account.",
    href: "/account/profile", actionLabel: "Account settings",
  }, {
    id: "providers", title: "Connect a debrid account", required: true,
    status: providerReady ? "complete" : "action",
    description: providerReady
      ? "An enabled provider has a saved key and is in your provider order. Its connection has not been tested here."
      : providers.some(p => p.configured)
        ? "You have a saved key, but no keyed provider is enabled in your current provider order. Review your settings or ask an administrator."
        : "Add your own debrid API key. Setup checks configuration only; test the connection on the Debrid page.",
    href: "/account/debrid", actionLabel: providerReady ? "Review or test connection" : "Configure debrid",
  }];
  const indexerCount = await db.indexerConfig.count({ where: { enabled: true } });
  checks.push({
    id: "indexers", title: "Connect your search sources", required: true, status: indexerCount ? "complete" : "action",
    description: indexerCount ? "An enabled Torznab indexer is configured. Test its connection in Indexers; this checklist does not contact it."
      : admin ? "Add your Jackett or Prowlarr Torznab endpoint and key, then test the connection."
      : "Your administrator needs to configure an enabled Torznab indexer before you can search.",
    href: indexerCount ? "/search" : admin ? "/admin/indexers" : null,
    actionLabel: indexerCount ? "Start a search" : admin ? "Configure indexers" : "Ask your administrator",
  });
  if (admin) checks.push({
    id: "library", title: "Plex / Jellyfin library", required: false,
    status: config.mediaSourceRoot && config.mediaLibraryRoot ? "complete" : "optional",
    description: config.mediaSourceRoot && config.mediaLibraryRoot
      ? "Both filesystem paths are configured. Open the library page to check mount access and export video files."
      : "Optional: mount your media and export scanner-friendly links. Normal stream playback does not require a mount.",
    href: "/admin/library", actionLabel: "Manage external library",
  });
  const required = checks.filter(check => check.required), completed = required.filter(check => check.status === "complete").length;
  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    product: "phosphor", role: admin ? "admin" : "user", configurationReady: completed === required.length,
    connectionVerified: false, progress: { completed, total: required.length }, providers, checks,
    indexers: { configured: indexerCount > 0 },
    ...(admin ? { library: { configured: Boolean(config.mediaSourceRoot && config.mediaLibraryRoot), verification: "not-tested" } } : {}),
  });
}));
