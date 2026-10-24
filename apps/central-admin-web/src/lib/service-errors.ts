import { inspectHttpError } from "@/lib/error-messages";

// Shared error contract for every current/future source-backed Admin screen.
// Never conflate permissions, validation, application bugs and outages.
export function isTemporaryDependencyError(error: unknown): boolean {
  const details = inspectHttpError(error);
  return details.responseCode === "DEPENDENCY_UNAVAILABLE" ||
    [502, 503, 504].includes(details.status ?? 0) ||
    (!details.hasResponse && details.hasRequest);
}

export function describeServiceError(error: unknown, serviceName: string): string {
  const details = inspectHttpError(error);
  if (details.status === 401) return "Your session has expired. Please sign in again.";
  if (details.status === 403) return "You are not authorized to view this information.";
  if (details.status === 404) return "This record or endpoint was not found.";
  if (details.status === 429) return "Too many requests. Please try again shortly.";
  if (details.status === 400 || details.status === 422) return "The request could not be processed. Please review your inputs.";
  if (isTemporaryDependencyError(error)) {
    return `${serviceName} is temporarily unavailable. Other Admin functions remain operational.`;
  }
  if (typeof details.status === "number" && details.status >= 500) {
    return `${serviceName} could not process this request. The issue has not been classified as a service outage.`;
  }
  return `${serviceName} data could not be loaded. Please retry or contact support.`;
}
