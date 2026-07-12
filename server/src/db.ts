import { PrismaClient } from "@prisma/client";

/** Single shared Prisma client. Tests point DATABASE_URL at a temp file. */
export const db = new PrismaClient();
