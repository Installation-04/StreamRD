import { Title, User } from "@prisma/client";
import { Response } from "express";
import { ZodType, ZodTypeDef } from "zod";
import { TitleSource } from "../providers/manager";

/** Strips secrets from a User row before it leaves the API. */
export function publicUser(user: User) {
  const { hashedPassword: _hashed, ...rest } = user;
  return rest;
}

function parseJsonArray<T>(json: string): T[] {
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/** Title with genres/sources decoded, sources optionally hidden from non-admins. */
export function publicTitle(title: Title, { includeSources = false } = {}) {
  const { sources, genres, ...rest } = title;
  return {
    ...rest,
    genres: parseJsonArray<string>(genres),
    sourceCount: parseJsonArray<TitleSource>(sources).length,
    ...(includeSources ? { sources: parseJsonArray<TitleSource>(sources) } : {}),
  };
}

export const titleSources = (title: Title): TitleSource[] =>
  parseJsonArray<TitleSource>(title.sources);

/** Parses a request body against a schema, replying 400 on failure. */
export function parseBody<Output, Input = Output>(
  schema: ZodType<Output, ZodTypeDef, Input>,
  body: unknown,
  res: Response
): Output | null {
  const result = schema.safeParse(body);
  if (!result.success) {
    res.status(400).json({
      error: "Invalid request",
      details: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
    return null;
  }
  return result.data;
}
