import { randomUUID } from "node:crypto";
import { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import { Prisma } from "@prisma/client";

export const asyncHandler = (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { void Promise.resolve().then(() => handler(req, res, next)).catch(next); };

export const requestId: RequestHandler = (_req, res, next) => {
  res.locals.requestId = randomUUID(); res.setHeader("X-Request-Id", res.locals.requestId); next();
};
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) { res.destroy(); return; }
  const bodyError = err?.type === "entity.parse.failed" ? 400 : err?.type === "entity.too.large" ? 413 : null;
  const conflict = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
  const status = bodyError ?? (conflict ? 409 : 500);
  const error = status === 400 ? "Invalid JSON body" : status === 413 ? "Request body too large" : status === 409 ? "Resource already exists" : "Internal server error";
  if (status === 500) console.error(JSON.stringify({ level: "error", type: "request_error", requestId: res.locals.requestId, method: req.method, route: req.route?.path ?? "unknown" }));
  res.status(status).json({ error, requestId: res.locals.requestId });
};
