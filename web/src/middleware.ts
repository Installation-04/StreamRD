import { NextRequest, NextResponse } from "next/server";

/**
 * Route gating for a nicer UX: unauthenticated visitors are bounced to
 * /login, non-admins away from /admin. This is a convenience only — the
 * backend enforces the real RBAC on every API call.
 */
export function middleware(req: NextRequest) {
  const token = req.cookies.get("sr_token")?.value;
  const role = req.cookies.get("sr_role")?.value;
  const { pathname } = req.nextUrl;

  if (pathname.startsWith("/admin")) {
    if (!token) return NextResponse.redirect(new URL("/login", req.url));
    if (role !== "admin") return NextResponse.redirect(new URL("/", req.url));
  }
  if ((pathname.startsWith("/account") || pathname.startsWith("/library")) && !token) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/account/:path*", "/library/:path*"],
};
