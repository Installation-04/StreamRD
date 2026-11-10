import { NextRequest, NextResponse } from "next/server";

/**
 * Route gating for a nicer UX: unauthenticated visitors are bounced to
 * /login, non-admins away from /admin. This is a convenience only — the
 * backend enforces the real RBAC on every API call.
 */
export function middleware(req: NextRequest) {
  // sr_role is set by the page script at sign-in; sr_token is HttpOnly for cookie sessions and may be on another origin in split installs.
  const token = req.cookies.get("sr_token")?.value || req.cookies.get("sr_role")?.value;
  const role = req.cookies.get("sr_role")?.value;
  const { pathname } = req.nextUrl;

  if (pathname.startsWith("/admin")) {
    if (!token) return NextResponse.redirect(new URL("/login", req.url));
    if (role !== "admin") return NextResponse.redirect(new URL("/", req.url));
  }
  if ((pathname.startsWith("/discover") || pathname.startsWith("/requests") || pathname.startsWith("/shared-libraries") || pathname.startsWith("/account") || pathname.startsWith("/library") || pathname.startsWith("/play")) && !token) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/discover/:path*", "/requests/:path*", "/shared-libraries/:path*", "/admin/:path*", "/account/:path*", "/library/:path*", "/play/:path*"],
};
