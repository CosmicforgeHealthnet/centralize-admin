import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Routing hint only. Real authorization happens on the API for every request:
// - legacy mode: `accessToken` (JS cookie, old contract)
// - dual/cookie mode: `cf_session=1`, a non-credential hint set by the app;
//   the credentials themselves are httpOnly cookies on the API domain.
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession =
    Boolean(request.cookies.get("accessToken")?.value) ||
    request.cookies.get("cf_session")?.value === "1";

  const isProtected = pathname.startsWith("/dashboard");
  const isAuthPage = pathname === "/";

  if (isProtected && !hasSession) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  if (isAuthPage && hasSession) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/dashboard/:path*"],
};
