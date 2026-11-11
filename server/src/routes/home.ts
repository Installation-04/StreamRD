import { Request, Response, Router } from "express";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/middleware";
import { getHomeSettings, saveHomeSettings } from "../home-settings";
import { asyncHandler } from "../http";
import { externalSections, librarySections } from "../home";
import { assertActiveSharedViewer } from "../shared-libraries";
import { AccountLibraryError } from "../account-library";
import { rateLimit } from "../util/rateLimit";
import { viewingLimit } from "../restrictions";

export const homeRouter = Router();
homeRouter.use((_req: Request, res: Response, next: () => void) => { res.setHeader("Cache-Control", "private, no-store"); next(); }, requireAuth);
homeRouter.get("/", rateLimit({ windowMs: 60_000, max: 60 }), asyncHandler(async (req, res) => {
  try {
    // Public trending lists are not rated, so an account with a viewing limit only sees its libraries.
    const limit = await viewingLimit(req.session!.sub);
    const none = { externalEnabled: false, trailersEnabled: false, trending: [], popularMovies: [], popularSeries: [], featured: [] };
    const [library, external] = await Promise.all([librarySections(req.session!.sub, req.session!.role, limit), limit === null ? externalSections() : Promise.resolve(none)]);
    await assertActiveSharedViewer(req.session!);
    const { libraryFeatured, ...rest } = library, { featured: outside, ...others } = external;
    const settings = await getHomeSettings();
    res.json({ ...rest, ...others, autoplayTrailers: settings.autoplayTrailers && Boolean((others as { trailersEnabled?: boolean }).trailersEnabled), featured: [...libraryFeatured, ...outside].slice(0, 6) });
  } catch (error) { if (error instanceof AccountLibraryError) { res.status(error.status).json({ error: error.message }); return; } throw error; }
}));

/** Admin → Overview: options for everyone's home page. */
export const adminHomeSettingsRouter = Router();
adminHomeSettingsRouter.use(requireAuth, requireAdmin, (_req: Request, res: Response, next: () => void) => { res.setHeader("Cache-Control", "private, no-store"); next(); });
adminHomeSettingsRouter.get("/", asyncHandler(async (_req, res) => { res.json(await getHomeSettings()); }));
adminHomeSettingsRouter.put("/", asyncHandler(async (req, res) => {
  const parsed = z.object({ autoplayTrailers: z.boolean() }).strict().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid home page settings." }); return; }
  res.json(await saveHomeSettings(parsed.data));
}));
