import { db } from "./db";

export type LogLevel = "info" | "warn" | "error";
export type LogType =
  | "signup"
  | "login"
  | "logout"
  | "search"
  | "download"
  | "provider_error"
  | "admin_action"
  | "system";

export interface LogFields {
  userId?: string;
  provider?: string;
  meta?: Record<string, unknown>;
}

/**
 * Structured event log: mirrored to stdout for `docker logs` and persisted so
 * admins can inspect recent activity via /api/admin/logs.
 */
export async function logEvent(
  level: LogLevel,
  type: LogType,
  message: string,
  fields: LogFields = {}
): Promise<void> {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    type,
    message,
    ...fields,
  });
  // eslint-disable-next-line no-console
  (level === "error" ? console.error : console.log)(line);
  try {
    await db.logEvent.create({
      data: {
        level,
        type,
        message,
        userId: fields.userId,
        provider: fields.provider,
        meta: fields.meta ? JSON.stringify(fields.meta) : null,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("logEvent persistence failed", err);
  }
}
