import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const accessToken = request.cookies.get("accessToken")?.value;

  const isProtected = pathname.startsWith("/dashboard");
  const isAuthPage = pathname === "/";

  if (isProtected && !accessToken) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  if (isAuthPage && accessToken) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/dashboard/:path*"],
};