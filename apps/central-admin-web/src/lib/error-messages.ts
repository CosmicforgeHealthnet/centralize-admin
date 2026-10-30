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

type UnknownRecord = Record<string, unknown>;
function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

export interface HttpErrorDetails {
  message?: string;
  responseError?: string;
  responseCode?: string;
  status?: number;
  transportCode?: string;
  originalMessage?: string;
  hasResponse: boolean;
  hasRequest: boolean;
  fieldErrors: string[];
  responseData?: UnknownRecord;
}

export function inspectHttpError(error: unknown): HttpErrorDetails {
  const root = asRecord(error);
  const response = asRecord(root?.response);
  const data = asRecord(response?.data);
  const rawErrors = Array.isArray(data?.errors) ? data.errors : [];
  const fieldErrors = rawErrors
    .map((item): string | null => {
      const entry = asRecord(item);
      return typeof entry?.message === "string" ? entry.message : null;
    })
    .filter((message): message is string => message !== null);
  return {
    message: typeof data?.message === "string" ? data.message : undefined,
    responseError: typeof data?.error === "string" ? data.error : undefined,
    responseCode: typeof data?.code === "string" ? data.code : undefined,
    status: typeof response?.status === "number" ? response.status : undefined,
    transportCode: typeof root?.code === "string" ? root.code : undefined,
    originalMessage: typeof root?.message === "string" ? root.message : undefined,
    hasResponse: response !== undefined,
    hasRequest: root?.request !== undefined,
    fieldErrors,
    responseData: data,
  };
}
