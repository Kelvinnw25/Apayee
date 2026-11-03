import Fastify, { LogController } from 'fastify';
import { ApiError, failureBody, toApiError } from './errors.js';
import { bearerAuthentication, rejectBrowserOrigins } from './middleware/authentication.js';
import { createProvider } from './providers/registry.js';
import { RequestQueue } from './queue/request-queue.js';
import { generateRoute } from './routes/generate.js';
import { healthRoute } from './routes/health.js';

/**
 * Assembles the service. Listening and process signals belong to server.js.
 *
 * @param {object} options
 * @param {ReturnType<import('./config.js').loadConfig>} options.config
 * @param {import('./providers/provider.js').Provider} [options.provider]  injected in tests
 * @param {NodeJS.WritableStream} [options.logStream]                      injected in tests
 * @param {NodeJS.ProcessEnv} [options.env]  what a provider that starts a program may pass on
 */
export async function buildApp({ config, provider, logStream, env = process.env }) {
  const app = Fastify({
    bodyLimit: config.maxBodyBytes,
    logger: { level: config.logLevel, ...(logStream ? { stream: logStream } : {}) },
    // Per-request logs are written by the routes, as an explicit list of metadata
    // fields. Nothing is logged merely because it was on the request.
    logController: new LogController({ disableRequestLogging: true }),
  });

  // After the logger exists, so a provider can report metadata-only events to it.
  const activeProvider =
    provider ??
    createProvider(config.provider, undefined, {
      config,
      env,
      onEvent: ({ level = 'info', ...event }) => app.log[level](event, 'Provider event.'),
    });

  const queue = new RequestQueue({
    maxPending: config.maxQueueSize,
    maxQueueWaitMs: config.maxQueueWaitMs,
    maxActive: config.maxConcurrent,
    abortGraceMs: config.abortGraceMs,
    logger: app.log,
  });

  // Fastify accepts text/plain by default. This API is JSON only, and text/plain is
  // the content type a browser can send cross-origin without a preflight.
  app.removeContentTypeParser('text/plain');

  app.decorate('queue', queue);
  app.decorateRequest('clientRequestId', null);
  app.decorateRequest('clientTask', null);
  app.decorateRequest('failureTiming', null);

  app.addHook('onRequest', rejectBrowserOrigins);
  if (config.authToken) app.addHook('onRequest', bearerAuthentication(config.authToken));

  // Before the server stops listening, so waiting clients get a real answer rather
  // than a dropped connection, and so server.close() is not left waiting on them.
  app.addHook('preClose', async () => {
    await queue.close();
  });

  app.setErrorHandler((error, request, reply) => {
    const apiError = toApiError(error);

    // Unknown errors are logged by class only: a message could quote request content.
    if (apiError.code === 'INTERNAL_ERROR') {
      request.log.error(
        { event: 'internal_error', error_class: error?.constructor?.name ?? 'unknown' },
        'Unhandled error.'
      );
    }

    request.log.info(
      {
        event: 'request_failed',
        request_id: request.clientRequestId,
        task: request.clientTask,
        provider: activeProvider.name,
        status: 'error',
        error_code: apiError.code,
        ...request.failureTiming,
      },
      'Request failed.'
    );

    if (apiError.code === 'UNAUTHORIZED') reply.header('www-authenticate', 'Bearer');
    return reply.code(apiError.statusCode).send(failureBody(request.clientRequestId, apiError));
  });

  app.setNotFoundHandler((request, reply) => {
    const apiError = new ApiError('NOT_FOUND');
    return reply.code(apiError.statusCode).send(failureBody(null, apiError));
  });

  const dependencies = { config, provider: activeProvider, queue };
  healthRoute(app, dependencies);
  generateRoute(app, dependencies);

  await app.ready();
  return app;
}
