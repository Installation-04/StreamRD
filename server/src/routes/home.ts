import { Request, Response, Router } from "express";
import { requireAuth } from "../auth/middleware";
import { asyncHandler } from "../http";
import { externalSections, librarySections } from "../home";
import { assertActiveSharedViewer } from "../shared-libraries";
import { AccountLibraryError } from "../account-library";
import { rateLimit } from "../util/rateLimit";

export const homeRouter = Router();
homeRouter.use((_req: Request, res: Response, next: () => void) => { res.setHeader("Cache-Control", "private, no-store"); next(); }, requireAuth);
homeRouter.get("/", rateLimit({ windowMs: 60_000, max: 60 }), asyncHandler(async (req, res) => {
  try {
    const [library, external] = await Promise.all([librarySections(req.session!.sub, req.session!.role), externalSections()]);
    await assertActiveSharedViewer(req.session!);
    const { libraryFeatured, ...rest } = library, { featured: outside, ...others } = external;
    res.json({ ...rest, ...others, featured: [...libraryFeatured, ...outside].slice(0, 6) });
  } catch (error) { if (error instanceof AccountLibraryError) { res.status(error.status).json({ error: error.message }); return; } throw error; }
}));
