import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../errors.js';

function digest(value) {
  return createHash('sha256').update(value).digest();
}

/**
 * Bearer token check. Runs on onRequest, before the body is read, so an unauthorized
 * caller cannot make the service buffer a large upload.
 *
 * Both sides are hashed first so the comparison is constant-time whatever the length
 * of the presented token.
 */
export function bearerAuthentication(expectedToken) {
  const expected = digest(expectedToken);

  return async function authenticate(request) {
    const match = /^Bearer +(\S+)$/i.exec(request.headers.authorization ?? '');
    if (!match || !timingSafeEqual(digest(match[1]), expected)) {
      throw new ApiError('UNAUTHORIZED');
    }
  };
}

/**
 * Apayee is called backend-to-backend, and those clients send no Origin header.
 * Browsers always send one on a POST, including under DNS rebinding, where a web page
 * reaches a loopback service as if it were same-origin. Refusing them closes that
 * route to an unauthenticated localhost service.
 */
export async function rejectBrowserOrigins(request) {
  if (request.headers.origin !== undefined) throw new ApiError('FORBIDDEN_ORIGIN');
}
