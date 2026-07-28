import { NextFunction, Request, Response } from "express";

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  message?: string;
}

/**
 * Minimal in-memory fixed-window rate limiter keyed by client IP. Enough to
 * blunt scripted brute-forcing on a single-process self-hosted deployment;
 * swap for a shared store (Redis) if you run multiple instances behind a
 * load balancer.
 */
// Above this many tracked IPs, sweep expired buckets before adding a new one
// so a flood of one-off callers (or IP spoofing) can't grow this unbounded.
const MAX_TRACKED_KEYS = 5000;

export function rateLimit({ windowMs, max, message }: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (buckets.size >= MAX_TRACKED_KEYS) {
        for (const [k, b] of buckets) {
          if (b.resetAt <= now) buckets.delete(k);
        }
      }
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    if (bucket.count >= max) {
      res.setHeader("Retry-After", Math.ceil((bucket.resetAt - now) / 1000));
      res.status(429).json({ error: message ?? "Too many requests, try again later" });
      return;
    }
    bucket.count++;
    next();
  };
}
