import { db } from "./db";
import { logEvent } from "./logger";
import { refreshPrimaries } from "./versions";

/** Two failed checks in a row make a link "broken"; one alone could be a hiccup. */
export const BROKEN_AFTER = 2;

/** What a check or a play attempt learned about an item: it works, the provider says it is gone, or nothing certain (a timeout, a rate limit, still downloading). */
export type LinkResult = { state: "ok" } | { state: "gone"; message: string } | { state: "transient" };

/**
 * Records what is known about one item's link and keeps the title's shown card honest: a broken version is never the card shown
 * while a working version of the same title exists, and it comes back when it works again.
 * Returns the health now in force and whether it just changed.
 */
export async function recordLinkResult(itemId: string, result: LinkResult): Promise<{ health: "unknown" | "ok" | "broken"; changed: boolean }> {
  const item = await db.accountMedia.findUnique({ where: { id: itemId }, select: { id: true, userId: true, name: true, groupKey: true, health: true, healthFailures: true } });
  if (!item) return { health: "unknown", changed: false };
  const now = new Date(), before = item.health === "broken" ? "broken" : item.health === "ok" ? "ok" : "unknown";
  if (result.state === "ok") {
    await db.accountMedia.update({ where: { id: item.id }, data: { health: "ok", healthFailures: 0, healthError: null, healthCheckedAt: now } });
    if (before === "broken") {
      await refreshPrimaries(db, item.userId, [item.groupKey]);
      void logEvent("info", "system", `Link recovered: ${item.name}`, { userId: item.userId, meta: { itemId: item.id } });
    }
    return { health: "ok", changed: before === "broken" };
  }
  if (result.state === "transient") {
    await db.accountMedia.update({ where: { id: item.id }, data: { healthCheckedAt: now } });
    return { health: before, changed: false };
  }
  const failures = item.healthFailures + 1, broken = failures >= BROKEN_AFTER;
  // The first failure only makes the item "unknown" so it is checked again within the hour.
  await db.accountMedia.update({ where: { id: item.id }, data: { healthFailures: failures, healthError: result.message.slice(0, 200), healthCheckedAt: now, health: broken ? "broken" : before === "broken" ? "broken" : "unknown" } });
  if (broken && before !== "broken") {
    await refreshPrimaries(db, item.userId, [item.groupKey]);
    void logEvent("warn", "system", `Link needs attention: ${item.name}`, { userId: item.userId, meta: { itemId: item.id, reason: result.message.slice(0, 120) } });
  }
  return { health: broken ? "broken" : "unknown", changed: broken && before !== "broken" };
}
