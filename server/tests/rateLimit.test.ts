import { describe, expect, it, vi } from "vitest";
import { rateLimit } from "../src/util/rateLimit";

// Minimal fakes — enough surface for the middleware, tested in isolation
// from the shared app/supertest so it doesn't interfere with the many real
// signups/logins other integration tests perform against the same IP.
function fakeReqRes(ip: string) {
  const req = { ip } as Parameters<ReturnType<typeof rateLimit>>[0];
  const headers: Record<string, unknown> = {};
  const res = {
    setHeader: vi.fn((k: string, v: unknown) => {
      headers[k] = v;
    }),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    headers,
  } as unknown as Parameters<ReturnType<typeof rateLimit>>[1];
  return { req, res };
}

describe("rateLimit", () => {
  it("allows requests under the max and blocks once it's exceeded", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 3, message: "slow down" });
    const next = vi.fn();
    for (let i = 0; i < 3; i++) {
      const { req, res } = fakeReqRes("1.2.3.4");
      limiter(req, res, next);
    }
    expect(next).toHaveBeenCalledTimes(3);

    const { req, res } = fakeReqRes("1.2.3.4");
    limiter(req, res, next);
    expect(next).toHaveBeenCalledTimes(3); // not called a 4th time
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({ error: "slow down" });
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", expect.any(Number));
  });

  it("tracks each IP independently", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 1 });
    const next = vi.fn();

    const a1 = fakeReqRes("10.0.0.1");
    limiter(a1.req, a1.res, next);
    const b1 = fakeReqRes("10.0.0.2");
    limiter(b1.req, b1.res, next);
    expect(next).toHaveBeenCalledTimes(2);

    const a2 = fakeReqRes("10.0.0.1");
    limiter(a2.req, a2.res, next);
    expect(a2.res.status).toHaveBeenCalledWith(429);
  });

  it("resets once the window elapses", () => {
    vi.useFakeTimers();
    try {
      const limiter = rateLimit({ windowMs: 1000, max: 1 });
      const next = vi.fn();
      const first = fakeReqRes("5.5.5.5");
      limiter(first.req, first.res, next);
      const blocked = fakeReqRes("5.5.5.5");
      limiter(blocked.req, blocked.res, next);
      expect(blocked.res.status).toHaveBeenCalledWith(429);

      vi.advanceTimersByTime(1001);
      const afterWindow = fakeReqRes("5.5.5.5");
      limiter(afterWindow.req, afterWindow.res, next);
      expect(next).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
