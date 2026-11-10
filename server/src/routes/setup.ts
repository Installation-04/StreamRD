import { getSharedSetupState } from "../shared-libraries";
import { countReadyAccountMedia, getAccountScanStatus } from "../account-library";
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
  const shared = await getSharedSetupState(userId);
  const sharedViewer = !admin && shared.libraryCount > 0;
  const [credentials, server, providerSettings] = await Promise.all([
    db.debridConfig.findUnique({ where: { userId } }), getServerSettings(), getProviderSettings(),
  ]);
  const availableOrder = credentials ? await debridManager.providerOrderFor(credentials, server, providerSettings) : [];
  const keys = credentials ? {
    realdebrid: credentials.realDebridToken, alldebrid: credentials.allDebridApiKey,
    premiumize: credentials.premiumizeApiKey, 
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
    id: "providers", title: sharedViewer ? "Server-managed playback" : "Connect a debrid account", required: !sharedViewer,
    status: sharedViewer || providerReady ? "complete" : "action",
    description: sharedViewer ? "Your administrator supplies playback for your shared libraries. You do not need your own debrid key. Stream availability is checked when you press Play." : providerReady
      ? "An enabled provider has a saved key and is in your provider order. Its connection has not been tested here."
      : providers.some(p => p.configured)
        ? "You have a saved key, but no keyed provider is enabled in your current provider order. Review your settings or ask an administrator."
        : "Add your own debrid API key. Setup checks configuration only; test the connection on the Debrid page.",
    href: sharedViewer ? "/shared-libraries" : "/account/debrid", actionLabel: sharedViewer ? "Open shared libraries" : providerReady ? "Review or test connection" : "Configure debrid",
  }];
  const privateReadyCount = await countReadyAccountMedia(userId);
  const contentReady = privateReadyCount > 0;
  checks.push({
    id: "catalog", title: contentReady ? "Your library has content" : "Something to watch", required: true, status: contentReady ? "complete" : "action",
    description: contentReady ? "Your connected account has finished items. Put them in a library to share them; playback availability is checked when you choose Play."
      : admin ? "Import finished items from your debrid account (Imports), then put them in a library for your family and friends."
      : "Your administrator needs to share a library with you before you can start watching.",
    href: contentReady ? "/library" : admin ? "/library" : null,
    actionLabel: contentReady ? "Open Imports" : admin ? "Import from your account" : "Ask your administrator",
  });
  if (admin) checks.push({
    id: "library", title: "Plex / Jellyfin library", required: false,
    status: config.mediaSourceRoot && config.mediaLibraryRoot ? "complete" : "optional",
    description: config.mediaSourceRoot && config.mediaLibraryRoot
      ? "Both filesystem paths are configured. Open the library page to check mount access and export video files."
      : "Optional: mount your media and export scanner-friendly links. Normal stream playback does not require a mount.",
    href: "/admin/library", actionLabel: "Manage external library",
  });
  if (sharedViewer) {
    const content = checks.find(check => check.id === "catalog" || check.id === "indexers");
    if (content) Object.assign(content, {
      title: "Your shared libraries", status: shared.readyCount > 0 ? "complete" : "action",
      description: shared.readyCount > 0
        ? "Your administrator has shared finished media with you. Open a shared library and choose Play; no personal provider setup is required."
        : "You have shared library access. Your administrator still needs to import finished media or restore the server’s provider configuration.",
      href: "/shared-libraries", actionLabel: "Open shared libraries",
    });
  }
  const accountLibrary = await getAccountScanStatus(userId);
  checks.push({ id: "account-library", title: "Your private debrid library", required: false, status: accountLibrary.totalImported ? "complete" : "optional", description: accountLibrary.totalImported ? "Existing provider items have been imported privately for this account. Open your library to review metadata or play a video." : "Scan existing torrents and cloud videos from your connected accounts. Scanning reads your providers; imported items stay private.", href: "/library", actionLabel: "Open your library" });
  const required = checks.filter(check => check.required), completed = required.filter(check => check.status === "complete").length;
  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    product: "streamrd", role: admin ? "admin" : "user", configurationReady: completed === required.length,
    accountLibrary, sharedLibraries: shared,
    connectionVerified: false, progress: { completed, total: required.length }, providers, checks,
    ...(admin ? { library: { configured: Boolean(config.mediaSourceRoot && config.mediaLibraryRoot), verification: "not-tested" } } : {}),
  });
}));
