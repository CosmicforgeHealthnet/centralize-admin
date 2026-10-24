import type { QueryClient } from "@tanstack/react-query";

// Lets non-React code (auth store, axios helpers) purge private cached data.
// Mail content lives only in this in-memory React Query cache; it is never
// written to localStorage/sessionStorage.
let activeClient: QueryClient | null = null;

export function registerQueryClient(client: QueryClient) {
  activeClient = client;
}

export function clearMailQueries() {
  if (!activeClient) return;
  activeClient.cancelQueries({ queryKey: ["mail"] });
  activeClient.removeQueries({ queryKey: ["mail"] });
}
