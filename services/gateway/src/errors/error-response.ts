export interface ErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly details?: unknown;
  };
}

export function createErrorResponse(
  code: string,
  message: string,
  requestId: string,
  details?: unknown,
): ErrorResponse {
  return details === undefined
    ? { error: { code, message, requestId } }
    : { error: { code, message, requestId, details } };
}
