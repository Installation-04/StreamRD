import { Prisma } from "@prisma/client";
import { db } from "./db";

/**
 * What the administrator should look at in a library: titles whose metadata match needs a decision (to review, none found, or an error)
 * and titles whose link stopped working. Viewers only ever see the link state on a card; the match state and these counts are for the administrator.
 */
export const MATCH_ATTENTION = ["review", "unmatched", "error"];
const CAP = 5000;

/** Ids of the owner's imports whose metadata match needs attention. */
async function unmatchedIds(ownerId: string): Promise<string[]> {
  const rows = await db.metadataRecord.findMany({ where: { targetType: "account", ownerId, status: { in: MATCH_ATTENTION } }, select: { targetId: true }, take: CAP });
  return rows.map(row => row.targetId);
}
/** A filter for the "Needs attention" view: a broken link, or a match to fix. */
export async function attentionWhere(ownerId: string): Promise<Prisma.AccountMediaWhereInput> {
  const ids = await unmatchedIds(ownerId);
  return { OR: [{ health: "broken" }, ...(ids.length ? [{ id: { in: ids } }] : [])] };
}
/** How many titles of a library (one per title, as the library lists them) need a match decision, and how many have a broken link. */
export async function attentionCounts(sourceWhere: Prisma.AccountMediaWhereInput, ownerId: string): Promise<{ match: number; links: number }> {
  const ids = await unmatchedIds(ownerId), base: Prisma.AccountMediaWhereInput[] = [sourceWhere, { isPrimary: true }];
  const [match, links] = await Promise.all([
    ids.length ? db.accountMedia.count({ where: { AND: [...base, { id: { in: ids } }] } }) : 0,
    db.accountMedia.count({ where: { AND: [...base, { health: "broken" }] } }),
  ]);
  return { match, links };
}
