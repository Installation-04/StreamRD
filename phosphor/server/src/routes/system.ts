import { Router } from "express";
import { requireAuth, requireAdmin } from "../auth/middleware";
import { asyncHandler } from "../http";
import { systemStatus } from "../system";
export const systemRouter = Router();
systemRouter.use(requireAuth, requireAdmin);
systemRouter.get("/", asyncHandler(async (_req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.json(await systemStatus("phosphor"));
}));
