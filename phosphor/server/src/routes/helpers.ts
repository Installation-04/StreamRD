import { User } from "@prisma/client";
import { Response } from "express";
import { ZodType, ZodTypeDef } from "zod";

/** Strips secrets from a User row before it leaves the API. */
export function publicUser(user: User) {
  const { hashedPassword: _hashed, ...rest } = user;
  return rest;
}

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
