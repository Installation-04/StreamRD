import { PrismaClient } from "@prisma/client";
import { decryptSecret, encryptSecret, isEncrypted } from "./crypto";
import { PRODUCT } from "./product";

/** Credential columns that are encrypted at rest, by model. Reads return plaintext; writes store ciphertext. */
const SECRET_FIELDS = PRODUCT.secretFields;

const base = new PrismaClient();
type Row = Record<string, unknown>;
function protect(data: unknown, fields: string[]): unknown {
  if (Array.isArray(data)) return data.map(item => protect(item, fields));
  if (!data || typeof data !== "object") return data;
  const out: Row = { ...(data as Row) };
  for (const field of fields) {
    const value = out[field];
    if (typeof value === "string") out[field] = encryptSecret(value);
    else if (value && typeof value === "object" && typeof (value as Row).set === "string") out[field] = { ...(value as Row), set: encryptSecret((value as Row).set as string) };
  }
  return out;
}
const queryExtension = Object.fromEntries(Object.entries(SECRET_FIELDS).map(([model, fields]) => [model, {
  async $allOperations({ args, query }: { args: Row; query: (args: Row) => Promise<unknown> }) {
    const next = { ...args };
    for (const part of ["data", "create", "update"]) if (next[part] !== undefined) next[part] = protect(next[part], fields);
    return query(next);
  },
}]));
const resultExtension = Object.fromEntries(Object.entries(SECRET_FIELDS).map(([model, fields]) => [model,
  Object.fromEntries(fields.map(field => [field, { needs: { [field]: true }, compute: (row: Row) => decryptSecret((row[field] as string | null) ?? null) }]))]));

/**
 * Single shared Prisma client. Tests point DATABASE_URL at a temp file. Credential columns are
 * encrypted transparently (see crypto.ts); the cast keeps the usual PrismaClient type for callers.
 */
export const db = base.$extends({ query: queryExtension, result: resultExtension } as never) as unknown as PrismaClient;

/** Encrypts credentials stored in plaintext by earlier versions. Safe to repeat; returns how many values changed. */
export async function encryptStoredSecrets(): Promise<number> {
  let changed = 0;
  for (const [model, fields] of Object.entries(SECRET_FIELDS)) {
    const delegate = (base as unknown as Record<string, { findMany: (a: unknown) => Promise<Row[]>; update: (a: unknown) => Promise<unknown> }>)[model];
    const idField = model === "debridConfig" ? "userId" : "id";
    for (const row of await delegate.findMany({ select: { [idField]: true, ...Object.fromEntries(fields.map(field => [field, true])) } })) {
      const data: Row = {};
      for (const field of fields) { const value = row[field]; if (typeof value === "string" && value && !isEncrypted(value)) { data[field] = encryptSecret(value); changed++; } }
      if (Object.keys(data).length) await delegate.update({ where: { [idField]: row[idField] }, data });
    }
  }
  // The qBittorrent connection password lives inside a JSON setting.
  const qbit = await base.setting.findUnique({ where: { key: "requests.qbit" } });
  if (qbit) {
    try {
      const value = JSON.parse(qbit.value) as Row;
      if (typeof value.password === "string" && value.password && !isEncrypted(value.password)) {
        await base.setting.update({ where: { key: "requests.qbit" }, data: { value: JSON.stringify({ ...value, password: encryptSecret(value.password) }) } });
        changed++;
      }
    } catch { /* a malformed setting is left untouched */ }
  }
  return changed;
}

/**
 * Write-ahead logging lets readers and the background workers proceed while one writer commits,
 * which avoids "database is locked" stalls. The mode is stored in the database file, so this is a
 * no-op after the first start. Set SQLITE_WAL=false on network file systems, where WAL is unsafe.
 */
export async function enableWal(): Promise<void> {
  if (process.env.SQLITE_WAL === "false" || !process.env.DATABASE_URL?.startsWith("file:")) return;
  try { await db.$queryRawUnsafe("PRAGMA journal_mode=WAL"); } catch { /* keep the default journal; never block startup */ }
}
