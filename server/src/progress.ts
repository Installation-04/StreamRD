import { createHash } from "node:crypto";
import { db } from "./db";

/** File identity excludes expiring CDN links and provider credentials. */
export const mediaKeyFor = (source: string, path: string, size?: number) => createHash("sha256").update(JSON.stringify([source, path, size ?? null])).digest("hex");

export async function ownsProfile(userId: string, profileId?: string) {
  return !profileId || !!await db.profile.findFirst({ where: { id: profileId, userId }, select: { id: true } });
}

export async function beginPlayback(userId: string, titleId: string, mediaKey: string, profileId?: string) {
  const scope = profileId ?? "";
  return db.$transaction(async tx => {
    const session = await tx.playbackSession.create({ data: { userId, titleId, mediaKey, scope, profileId, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } });
    const progress = await tx.playbackProgress.upsert({
      where: { userId_scope_titleId_mediaKey: { userId, scope, titleId, mediaKey } },
      create: { userId, scope, profileId, titleId, mediaKey, activeSessionId: session.id },
      update: { activeSessionId: session.id },
    });
    return { sessionId: session.id, resumeSeconds: progress.completed ? 0 : progress.positionSeconds, durationSeconds: progress.durationSeconds };
  });
}
