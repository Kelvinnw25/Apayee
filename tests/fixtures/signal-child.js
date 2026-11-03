import { MockProvider } from '../../src/providers/mock/mock.provider.js';
import { startServer } from '../../src/server.js';

/**
 * Runs the real startServer in its own process for the shutdown test. The event
 * loop must empty by itself for this to exit 0: nothing here calls process.exit,
 * so a leaked timer, handle or unresolved shutdown makes the test fail by hanging.
 */
const { app, address } = await startServer({
  env: { APAYEE_PORT: '0', APAYEE_LOG_LEVEL: 'silent' },
  provider: new MockProvider({ latencyMs: 30_000 }),
});

process.send({ address });

process.on('message', async (message) => {
  if (message.type === 'await-active') {
    while (app.queue.stats().active === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    process.send({ active: true });
  }

  if (message.type === 'signal') {
    process.emit(message.signal);
    // The IPC channel would otherwise keep the process alive after shutdown. On POSIX the
    // SIGTERM listener below has already closed it by now, and a second close throws.
    if (process.connected) process.disconnect();
  }
});

// Lets a real signal in the POSIX-only test end the process without an IPC command.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => process.connected && process.disconnect());
}
