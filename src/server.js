import { pathToFileURL } from 'node:url';
import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';

/** SIGBREAK is what Ctrl+Break delivers on Windows. Elsewhere it never fires. */
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK'];

/**
 * Starts the service and arranges graceful shutdown.
 *
 * Shutdown policy: stop immediately, don't drain. Pending requests are rejected and
 * the active one is aborted, each answered with SERVICE_SHUTTING_DOWN (retryable),
 * because clients own their workflow state and can resend. A generation in progress
 * could otherwise hold a restart for minutes.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {NodeJS.EventEmitter} [options.signals]  where shutdown signals arrive from
 * @param {NodeJS.WritableStream} [options.logStream]
 * @param {import('./providers/provider.js').Provider} [options.provider]
 */
export async function startServer({
  env = process.env,
  signals = process,
  logStream,
  provider,
} = {}) {
  const config = loadConfig(env);
  const app = await buildApp({ config, logStream, provider, env });
  const address = await app.listen({ host: config.host, port: config.port });

  let shuttingDown = null;
  const shutdown = (signal = 'manual') => {
    shuttingDown ??= (async () => {
      app.log.info({ event: 'shutdown_started', signal }, 'Shutting down.');

      const deadline = setTimeout(() => {
        app.log.error({ event: 'shutdown_forced' }, 'Shutdown timed out; exiting anyway.');
        process.exit(1);
      }, config.shutdownTimeoutMs);
      deadline.unref();

      try {
        await app.close();
        app.log.info({ event: 'shutdown_finished' }, 'Shutdown complete.');
      } finally {
        clearTimeout(deadline);
        for (const name of SHUTDOWN_SIGNALS) signals.off(name, handlers[name]);
      }
    })();
    return shuttingDown;
  };

  const handlers = Object.fromEntries(SHUTDOWN_SIGNALS.map((name) => [name, () => shutdown(name)]));
  for (const name of SHUTDOWN_SIGNALS) signals.on(name, handlers[name]);

  app.log.info(
    { event: 'server_started', provider: config.provider, remote_access: config.allowRemote },
    'Apayee is listening.'
  );

  return { app, address, shutdown };
}

const isEntryPoint =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isEntryPoint) {
  startServer().catch((error) => {
    // A ConfigError is written for operators and never quotes a secret. Anything
    // else may hold arbitrary text, so only its class is printed.
    const message =
      error instanceof ConfigError || error?.code === 'EADDRINUSE'
        ? error.message
        : `Startup failed (${error?.constructor?.name ?? 'unknown error'}).`;
    console.error(`Apayee did not start: ${message}`);
    process.exit(1);
  });
}
