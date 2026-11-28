"use client";

import { useSyncExternalStore } from "react";

// Reads one query parameter of the current URL without a Suspense boundary
// (useSearchParams would force one on statically rendered pages). The server
// snapshot is empty, so hydration matches and the client value follows.
function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}

export function useSearchParam(name: string): string | null {
  const search = useSyncExternalStore(subscribe, () => window.location.search, () => "");
  return new URLSearchParams(search).get(name);
}
