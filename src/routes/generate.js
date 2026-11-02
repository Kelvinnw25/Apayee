import { ApiError, toApiError } from '../errors.js';
import { echoableRequestId, parseGenerateRequest } from '../validation/request.js';

/**
 * The provider's reply, checked as the client will receive it.
 *
 * Round-tripping through JSON first means a Date, NaN or undefined cannot pass
 * validation in one form and be delivered in another.
 */
function acceptedResult(output, validateResult) {
  let data;
  try {
    data = JSON.parse(JSON.stringify(output?.data));
  } catch {
    throw new ApiError('INVALID_PROVIDER_RESPONSE', 'The provider returned non-JSON output.');
  }

  // A string here is how Markdown-wrapped JSON would arrive.
  if (data === null || typeof data !== 'object') {
    throw new ApiError('INVALID_PROVIDER_RESPONSE', 'The provider did not return structured JSON.');
  }

  const { valid, errors } = validateResult(data);
  if (!valid) throw new ApiError('INVALID_PROVIDER_RESPONSE', undefined, errors);

  return data;
}

/** Whatever a provider throws, its own message is never relayed unless it chose ApiError. */
function providerFailure(error) {
  return error instanceof ApiError ? error : new ApiError('PROVIDER_UNAVAILABLE');
}

function elapsedSince(start) {
  return Math.round(performance.now() - start);
}

export function generateRoute(app, { config, provider, queue }) {
  app.post('/v1/generate', async (request, reply) => {
    const receivedAt = performance.now();
    request.clientRequestId = echoableRequestId(request.body);

    const input = parseGenerateRequest(request.body, { config, provider });
    request.clientTask = input.task;

    // A response 'close' before it finished writing means the client went away.
    const disconnect = new AbortController();
    const onResponseClose = () => {
      if (!reply.raw.writableFinished) disconnect.abort();
    };
    reply.raw.once('close', onResponseClose);
    if (request.raw.socket?.destroyed) disconnect.abort();

    // Queue wait starts here, so validating the request does not read as queueing.
    const enqueuedAt = performance.now();
    let startedAt = null;
    const timing = () => {
      const queueWaitMs = Math.round((startedAt ?? performance.now()) - enqueuedAt);
      const executionMs = startedAt === null ? 0 : elapsedSince(startedAt);
      return {
        queue_wait_ms: queueWaitMs,
        execution_time_ms: executionMs,
        total_time_ms: elapsedSince(receivedAt),
      };
    };

    try {
      const { data, usage } = await queue.enqueue({
        requestId: input.requestId,
        timeoutMs: input.timeoutMs,
        signal: disconnect.signal,
        run: async (signal) => {
          startedAt = performance.now();

          let output;
          try {
            output = await provider.generate({
              system: input.system,
              prompt: input.prompt,
              schema: input.schema,
              task: input.task,
              timeoutMs: input.timeoutMs,
              signal,
            });
          } catch (error) {
            throw providerFailure(error);
          }

          return {
            data: acceptedResult(output, input.validateResult),
            usage: output?.usage,
          };
        },
      });

      const metadata = timing();
      request.log.info(
        {
          event: 'generate_finished',
          request_id: input.requestId,
          task: input.task,
          provider: provider.name,
          status: 'success',
          ...metadata,
        },
        'Generation finished.'
      );

      return {
        request_id: input.requestId,
        status: 'success',
        provider: provider.name,
        result: data,
        metadata: { ...metadata, ...(usage ? { usage } : {}) },
      };
    } catch (error) {
      request.failureTiming = timing();
      throw toApiError(error);
    } finally {
      reply.raw.off('close', onResponseClose);
    }
  });
}
