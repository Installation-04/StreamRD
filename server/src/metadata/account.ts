import { AccountMedia } from "@prisma/client";
import { db } from "../db";
import { queueAutomaticTargets, storedMetadata } from "./automation";

/** Only decorate rows already selected through the caller's account boundary. */
export async function decorateAccountMedia<T extends { id: string; userId: string }>(items: T[]) {
  const records = new Map<string, { ownerId: string | null; data: string; status: string }>();
  for (let offset = 0; offset < items.length; offset += 100) {
    const batch = items.slice(offset, offset + 100);
    const found = await db.metadataRecord.findMany({ where: { targetType: "account", targetId: { in: batch.map(item => item.id) }, ownerId: { in: [...new Set(batch.map(item => item.userId))] } }, select: { targetId: true, ownerId: true, data: true, status: true } });
    for (const record of found) records.set(record.targetId, record);
  }
  return items.map(item => {
    const row = records.get(item.id), owned = row?.ownerId === item.userId;
    return { ...item, metadata: owned ? storedMetadata(row.data) : null, metadataStatus: owned ? row.status : null };
  });
}
export async function queueImportedMetadata(items: AccountMedia[]) {
  await queueAutomaticTargets(items.map(item => ({ targetType: "account", targetId: item.id, ownerId: item.userId,
    name: item.name, mediaType: item.type === "series" ? "series" : "movie", year: item.year })));
}
