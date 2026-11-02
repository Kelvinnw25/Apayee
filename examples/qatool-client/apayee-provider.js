import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

/**
 * What a QATOOL adapter for Apayee would look like.
 *
 * It implements the LLMProvider contract verified in QATOOL's server/llm/provider.js:
 *
 *   generateJson({ system, prompt, schema, signal }) -> { data, usage }
 *
 * and throws errors carrying `code` and `statusCode` in QATOOL's LLM_* vocabulary.
 *
 * Two things QATOOL's contract has no field for, and Apayee requires:
 *
 *   request_id  generated here unless the caller passes `requestId`.
 *   task        defaults to 'generic' unless the caller passes `task`. A real adapter
 *               can work with the three-argument call sites unchanged.
 *
 * Uses node:http rather than fetch. Apayee answers synchronously, so the response
 * headers arrive only when generation ends, and fetch's default 300-second
 * headersTimeout would abort anything that spends longer queued and executing.
 */
const LLM_CODE_FOR = {
  UNAUTHORIZED: 'LLM_AUTH_FAILED',
  QUEUE_FULL: 'LLM_RATE_LIMITED',
  // The provider is switched off, signed out or unconfirmed: a configuration state that
  // waiting does not fix. Mapped to a configuration error, not to a temporary overload.
  PROVIDER_NOT_READY: 'LLM_NOT_CONFIGURED',
  // Brief throttling, or a usage allowance that needs its reset; the message says which.
  PROVIDER_RATE_LIMITED: 'LLM_RATE_LIMITED',
  PROVIDER_TIMEOUT: 'LLM_TIMEOUT',
  QUEUE_TIMEOUT: 'LLM_TIMEOUT',
  INVALID_PROVIDER_RESPONSE: 'LLM_MALFORMED_OUTPUT',
  PROVIDER_UNAVAILABLE: 'LLM_UNAVAILABLE',
  SERVICE_SHUTTING_DOWN: 'LLM_UNAVAILABLE',
};

export class ApayeeClientError extends Error {
  constructor(code, message, statusCode, { apayeeCode = null, retryable = false } = {}) {
    super(message);
    this.name = 'ApayeeClientError';
    this.code = code;
    this.statusCode = statusCode;
    this.apayeeCode = apayeeCode;
    this.retryable = retryable;
  }
}

export class ApayeeProvider {
  /**
   * @param {object} settings
   * @param {string} settings.baseUrl
   * @param {string} [settings.token]
   * @param {number} [settings.timeoutMs]  sent as timeout_ms; server default when absent
   */
  constructor({ baseUrl, token, timeoutMs }) {
    this.name = 'Apayee';
    this.model = 'apayee-gateway';
    this.baseUrl = baseUrl;
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async generateJson({ system, prompt, schema, signal, task = 'generic', requestId }) {
    const body = await this.#post(
      '/v1/generate',
      {
        request_id: requestId ?? `qatool-${randomUUID()}`,
        task,
        system,
        prompt,
        schema,
        ...(this.timeoutMs ? { timeout_ms: this.timeoutMs } : {}),
      },
      signal
    );

    if (body.status !== 'success') {
      const { code, message, retryable } = body.error;
      throw new ApayeeClientError(
        LLM_CODE_FOR[code] ?? 'LLM_NOT_CONFIGURED',
        message,
        body.httpStatus,
        {
          apayeeCode: code,
          retryable,
        }
      );
    }

    return { data: body.result, usage: body.metadata.usage ?? {}, metadata: body.metadata };
  }

  #post(path, payload, signal) {
    const url = new URL(path, this.baseUrl);
    const transport = url.protocol === 'https:' ? https : http;
    const encoded = JSON.stringify(payload);

    return new Promise((resolve, reject) => {
      const request = transport.request(
        url,
        {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(encoded),
            ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          },
        },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('error', reject);
          response.on('end', () => {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              resolve({ ...parsed, httpStatus: response.statusCode });
            } catch {
              reject(new ApayeeClientError('LLM_MALFORMED_OUTPUT', 'Apayee sent non-JSON.', 502));
            }
          });
        }
      );

      request.on('error', (cause) => {
        // A caller's abort stays an abort, exactly as it would with fetch.
        if (signal?.aborted) reject(cause);
        else
          reject(
            new ApayeeClientError(
              'LLM_UNAVAILABLE',
              `Could not reach Apayee: ${cause.code ?? cause.message}`,
              502
            )
          );
      });
      request.end(encoded);
    });
  }
}
