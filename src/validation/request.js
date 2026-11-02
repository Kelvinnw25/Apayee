import { Ajv } from 'ajv';
import { ApiError } from '../errors.js';
import { compileClientSchema } from './json-schema.js';

/**
 * The POST /v1/generate body.
 *
 * Validated here rather than through Fastify's route schema, whose default Ajv
 * coerces types: `"timeout_ms": "9"` would quietly become 9. Nothing about a
 * client's request gets changed on the way in.
 *
 * additionalProperties is false so a client cannot believe it chose a provider
 * or a model by sending a field that was silently ignored.
 */
const REQUEST_ID = '^[A-Za-z0-9._:-]{1,128}$';
const TASK = '^[a-z0-9_.-]{1,64}$';

const validateBody = new Ajv({ allErrors: true, logger: false }).compile({
  type: 'object',
  additionalProperties: false,
  required: ['request_id', 'task', 'system', 'prompt', 'schema'],
  properties: {
    request_id: { type: 'string', pattern: REQUEST_ID },
    task: { type: 'string', pattern: TASK },
    system: { type: 'string' },
    prompt: { type: 'string', minLength: 1 },
    schema: { type: 'object' },
    timeout_ms: { type: 'integer', minimum: 1 },
  },
});

const REQUEST_ID_SHAPE = new RegExp(REQUEST_ID);

/**
 * The id to echo in a failure, if the request carried a usable one. Never reflects
 * an unchecked value, which could be enormous or inject lines into a log.
 */
export function echoableRequestId(body) {
  const id = body?.request_id;
  return typeof id === 'string' && REQUEST_ID_SHAPE.test(id) ? id : null;
}

/**
 * @returns {{requestId: string, task: string, system: string, prompt: string,
 *            schema: object, timeoutMs: number, validateResult: Function}}
 * @throws {ApiError} before anything has been queued
 */
export function parseGenerateRequest(body, { config, provider }) {
  if (!validateBody(body)) {
    const details = validateBody.errors.map((error) => ({
      path: error.instancePath || '/',
      message: error.message,
    }));
    throw new ApiError('INVALID_REQUEST', undefined, details);
  }

  const timeoutMs = body.timeout_ms ?? config.defaultTimeoutMs;
  if (timeoutMs > config.maxTimeoutMs) {
    throw new ApiError(
      'INVALID_REQUEST',
      `timeout_ms must not exceed the server maximum of ${config.maxTimeoutMs}.`
    );
  }

  if (!provider.supportsTask(body.task)) {
    throw new ApiError(
      'UNSUPPORTED_TASK',
      `The active provider does not support task '${body.task}'.`
    );
  }

  return {
    requestId: body.request_id,
    task: body.task,
    system: body.system,
    prompt: body.prompt,
    schema: body.schema,
    timeoutMs,
    validateResult: compileClientSchema(body.schema, { maxBytes: config.maxSchemaBytes }),
  };
}
