// Read an Axios-compatible error message without relying on untyped catch variables.
export function readHttpErrorMessage(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const response = (error as { response?: unknown }).response;
  if (typeof response !== "object" || response === null) return undefined;
  const data = (response as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return undefined;
  const message = (data as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}
