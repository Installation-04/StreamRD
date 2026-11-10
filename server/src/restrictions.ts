import { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { db } from "./db";

/** The signed-in person's viewing limit (highest minimum age they may see), or null for no limit. Read from the database on every request. */
export async function viewingLimit(userId: string): Promise<number | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { role: true, maxAge: true } });
  return user && user.role !== "admin" ? user.maxAge : null;
}
/** Titles above the limit, and titles with no rating at all, are excluded. */
export const ageWhere = (limit: number | null): Prisma.AccountMediaWhereInput => limit === null ? {} : { minAge: { lte: limit } };
/** Limited accounts only watch what the administrator's libraries show them; discovery, requests and personal libraries are closed to them. */
export async function requireUnrestricted(req: Request, res: Response, next: NextFunction) {
  try {
    if (req.session && await viewingLimit(req.session.sub) !== null) { res.status(403).json({ error: "This account has a viewing limit. Ask the server administrator." }); return; }
    next();
  } catch (error) { next(error); }
}
