// The one error type handlers throw, and the body it becomes.

import { ErrorCode } from "../domain/enums.ts";

/** A failure with an HTTP status and a code the caller can switch on. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly headers: Readonly<Record<string, string>>;

  /**
   * Create an error that becomes an HTTP response.
   *
   * @param status - The HTTP status.
   * @param code - The machine-readable code.
   * @param message - A sentence that tells the caller what to change.
   * @param details - Optional structured detail, such as field errors.
   * @param headers - Extra response headers, such as `Retry-After`.
   */
  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    details?: unknown,
    headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

/** The JSON body of every error response. */
export interface ErrorBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly details?: unknown;
  };
}

/**
 * The body for an error.
 *
 * @param error - The error to describe.
 * @returns The JSON-serialisable body.
 */
export const errorBody = (error: ApiError): ErrorBody => ({
  error: {
    code: error.code,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
  },
});

/**
 * 400: the request is not valid.
 *
 * @param message - What is wrong and what to change.
 * @param details - Structured detail, such as which fields failed.
 * @returns The error to throw.
 */
export const badRequest = (message: string, details?: unknown): ApiError =>
  new ApiError(400, ErrorCode.INVALID_REQUEST, message, details);

/**
 * 401: no valid credentials.
 *
 * @param message - What to send instead.
 * @returns The error to throw.
 */
export const unauthorized = (
  message = "A valid API key is required. Send it as `Authorization: Bearer <key>`.",
): ApiError =>
  new ApiError(401, ErrorCode.UNAUTHORIZED, message, undefined, { "WWW-Authenticate": "Bearer" });

/**
 * 403: credentials are valid but do not allow this.
 *
 * @param message - Why this is not allowed.
 * @returns The error to throw.
 */
export const forbidden = (message: string): ApiError =>
  new ApiError(403, ErrorCode.FORBIDDEN, message);

/**
 * 404: no such record.
 *
 * @param message - What was not found.
 * @returns The error to throw.
 */
export const notFound = (message: string): ApiError =>
  new ApiError(404, ErrorCode.NOT_FOUND, message);

/**
 * 409: the request conflicts with what is stored.
 *
 * @param message - What conflicts.
 * @param details - Structured detail, such as the id of the existing record.
 * @returns The error to throw.
 */
export const conflict = (message: string, details?: unknown): ApiError =>
  new ApiError(409, ErrorCode.CONFLICT, message, details);

/**
 * 503: a feature the operator has not configured.
 *
 * @param message - Which setting turns the feature on.
 * @returns The error to throw.
 */
export const notConfigured = (message: string): ApiError =>
  new ApiError(503, ErrorCode.NOT_CONFIGURED, message);
