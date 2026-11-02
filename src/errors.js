/**
 * Every failure a client can see.
 *
 * The code is the contract: clients branch on it and on `retryable`, never on
 * the message. Apayee itself retries nothing, so `retryable` tells the client
 * whether sending the same request again could reasonably succeed.
 */
export const ERROR_CATALOG = {
  INVALID_REQUEST: [400, false, 'The request body is not valid.'],
  INVALID_SCHEMA: [400, false, 'The supplied JSON Schema is not valid or not supported.'],
  UNSUPPORTED_TASK: [400, false, 'The active provider does not support this task.'],
  UNAUTHORIZED: [401, false, 'A valid bearer token is required.'],
  FORBIDDEN_ORIGIN: [403, false, 'Browser-originated requests are not accepted.'],
  NOT_FOUND: [404, false, 'No such endpoint.'],
  DUPLICATE_REQUEST_ID: [
    409,
    false,
    'A request with this request_id is already queued or running.',
  ],
  REQUEST_TOO_LARGE: [413, false, 'The request body exceeds the configured size limit.'],
  UNSUPPORTED_MEDIA_TYPE: [415, false, 'The request Content-Type must be application/json.'],
  QUEUE_FULL: [429, true, 'The request queue is full.'],
  REQUEST_CANCELLED: [499, true, 'The request was cancelled by the client.'],
  INTERNAL_ERROR: [500, false, 'An internal error occurred.'],
  INVALID_PROVIDER_RESPONSE: [
    502,
    true,
    'The provider returned output that does not satisfy the request schema.',
  ],
  PROVIDER_UNAVAILABLE: [503, true, 'The provider could not complete the request.'],
  // The provider is deliberately configured off, signed out or unconfirmed. Waiting does
  // not fix it, so clients must not present it as a temporary overload.
  PROVIDER_NOT_READY: [503, false, 'The provider is not ready to take requests.'],
  // The provider (or its subscription allowance) is limiting requests. The message says
  // whether that is brief throttling or an exhausted allowance that needs a reset.
  PROVIDER_RATE_LIMITED: [429, true, 'The provider is limiting requests.'],
  QUEUE_TIMEOUT: [503, true, 'The request waited too long in the queue.'],
  SERVICE_SHUTTING_DOWN: [503, true, 'The service is shutting down.'],
  PROVIDER_TIMEOUT: [504, true, 'Provider execution exceeded the configured timeout.'],
};

export class ApiError extends Error {
  /**
   * @param {keyof typeof ERROR_CATALOG} code
   * @param {string} [message]  overrides the catalog text; must not contain request content
   * @param {object[]} [details]
   */
  constructor(code, message, details) {
    const [statusCode, retryable, defaultMessage] = ERROR_CATALOG[code];
    super(message ?? defaultMessage);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.details = details;
  }
}

/** Framework failures that happen before a route runs, in Apayee's vocabulary. */
const FASTIFY_CODES = {
  FST_ERR_CTP_BODY_TOO_LARGE: 'REQUEST_TOO_LARGE',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
};

/**
 * Anything thrown becomes an ApiError. Unknown errors lose their message on the
 * way through: it could quote a prompt, a path or a credential.
 */
export function toApiError(error) {
  if (error instanceof ApiError) return error;
  if (FASTIFY_CODES[error?.code]) return new ApiError(FASTIFY_CODES[error.code]);

  const isClientFault = error?.statusCode >= 400 && error?.statusCode < 500;
  if (isClientFault) return new ApiError('INVALID_REQUEST', 'The request could not be parsed.');

  return new ApiError('INTERNAL_ERROR');
}

export function failureBody(requestId, apiError) {
  return {
    request_id: requestId ?? null,
    status: 'error',
    error: {
      code: apiError.code,
      message: apiError.message,
      retryable: apiError.retryable,
      ...(apiError.details ? { details: apiError.details } : {}),
    },
  };
}
