import { createRequire } from 'node:module';

const { version } = createRequire(import.meta.url)('../../package.json');

/**
 * What a provider reports about itself, safe to show: a state and a sentence, never
 * a path, a credential or request content.
 */
async function providerStatus(provider) {
  try {
    return await provider.status();
  } catch {
    return { ready: false, state: 'status_unavailable' };
  }
}

/** Operational state only: no paths, no configuration values, no request content. */
export function healthRoute(app, { provider, queue, config }) {
  app.get('/v1/health', async () => {
    const stats = queue.stats();
    const status = await providerStatus(provider);

    return {
      status: queue.closed ? 'shutting_down' : 'ok',
      service: 'apayee',
      version,
      // The provider's name appears only while it can take work, so a client that
      // looks for a specific name (QATOOL looks for `claude`) never finds one that
      // is not usable. Otherwise it reads `<name>_not_ready`; `provider_status`
      // says why.
      provider: status.ready ? provider.name : `${provider.name}_not_ready`,
      provider_status: {
        ready: status.ready,
        state: status.state,
        ...(status.reason ? { reason: status.reason } : {}),
        ...(status.cli_version ? { cli_version: status.cli_version } : {}),
      },
      queue: {
        length: stats.pending,
        running: stats.active > 0,
        capacity: config.maxQueueSize,
        abandoned: stats.abandoned,
        totals: {
          succeeded: stats.succeeded,
          failed: stats.failed,
          timed_out: stats.timedOut,
          cancelled: stats.cancelled,
          rejected: stats.rejected,
        },
      },
    };
  });
}
