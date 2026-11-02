import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { Writable } from 'node:stream';
import { describe, test } from 'node:test';
import { MockProvider } from '../src/providers/mock/mock.provider.js';
import { startServer } from '../src/server.js';
import { postJson, requestBody, startTestServer, waitFor } from './helpers/harness.js';

describe('graceful shutdown', () => {
  test('answers the active and pending requests, then closes', async () => {
    let activeSignal;
    const server = await startTestServer({
      provider: new MockProvider({
        latencyMs: 30_000,
        onCall: ({ signal }) => (activeSignal = signal),
      }),
    });

    const responses = [
      server.post(requestBody({ request_id: 'active' })),
      server.post(requestBody({ request_id: 'p1' })),
      server.post(requestBody({ request_id: 'p2' })),
    ];
    await waitFor(() => server.app.queue.stats().pending === 2);

    await server.close();

    for (const response of await Promise.all(responses)) {
      assert.equal(response.status, 503);
      assert.equal(response.body.error.code, 'SERVICE_SHUTTING_DOWN');
      assert.equal(response.body.error.retryable, true);
    }
    assert.equal(activeSignal.aborted, true);

    const { pending, active } = server.app.queue.stats();
    assert.deepEqual({ pending, active }, { pending: 0, active: 0 });
  });

  test('stops accepting connections', async () => {
    const server = await startTestServer();
    await server.close();
    await assert.rejects(server.post(requestBody()));
  });

  test('shutdown completes when the provider ignores its abort', async () => {
    const server = await startTestServer({
      config: { abortGraceMs: 20 },
      provider: new MockProvider({ latencyMs: 300, ignoreAbort: true }),
    });

    const response = server.post(requestBody());
    await waitFor(() => server.app.queue.stats().active === 1);

    await server.close();
    assert.equal((await response).body.error.code, 'SERVICE_SHUTTING_DOWN');
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    test(`${signal} shuts the service down through startServer`, async () => {
      const signals = new EventEmitter();
      let logs = '';
      const logStream = new Writable({
        write(chunk, _encoding, done) {
          logs += chunk;
          done();
        },
      });

      const { app, address, shutdown } = await startServer({
        env: { APAYEE_PORT: '0' },
        signals,
        logStream,
        provider: new MockProvider({ latencyMs: 30_000 }),
      });

      const response = postJson(address, requestBody());
      await waitFor(() => app.queue.stats().active === 1);

      signals.emit(signal);
      const { status, body } = await response;
      assert.equal(status, 503);
      assert.equal(body.error.code, 'SERVICE_SHUTTING_DOWN');

      await shutdown();
      assert.match(logs, /shutdown_finished/);
      assert.equal(signals.listenerCount(signal), 0, 'handlers are removed afterwards');
    });
  }

  test('a real process exits cleanly on its shutdown handler, with a request in flight', async () => {
    const child = fork(new URL('./fixtures/signal-child.js', import.meta.url), {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));

    const [{ address }] = await once(child, 'message');

    const response = postJson(address, requestBody());
    child.send({ type: 'await-active' });
    await once(child, 'message');

    // Windows cannot deliver a catchable signal to another process, so the child
    // emits it on itself. This exercises the real handlers and real process exit.
    child.send({ type: 'signal', signal: process.platform === 'win32' ? 'SIGBREAK' : 'SIGTERM' });

    const { body } = await response;
    assert.equal(body.error.code, 'SERVICE_SHUTTING_DOWN');

    const [code] = child.exitCode === null ? await once(child, 'exit') : [child.exitCode];
    assert.equal(code, 0, `child exited ${code}: ${stderr}`);
  });

  test(
    'a real OS signal stops a real process',
    { skip: process.platform === 'win32' },
    async () => {
      const child = fork(new URL('./fixtures/signal-child.js', import.meta.url), {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      await once(child, 'message');

      child.kill('SIGTERM');
      const [code] = await once(child, 'exit');
      assert.equal(code, 0);
    }
  );
});
