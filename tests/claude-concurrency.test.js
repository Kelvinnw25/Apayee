import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  cleanUpScratchAfterTests,
  fakeProvider,
  isAlive,
  readPids,
} from './helpers/fake-claude.js';
import { requestBody, startTestServer, waitFor } from './helpers/harness.js';

/**
 * Several Claude CLI runs at once, against the fake CLI only. Nothing here reaches a model
 * or a login, so these tests show how Apayee isolates and stops its own processes. They
 * cannot show whether the real CLI is safe to run several times against one shared sign-in.
 */
cleanUpScratchAfterTests();

const count = (harness, kind) => harness.calls().filter((call) => call.kind === kind).length;

const accounted = (server) => {
  const s = server.app.queue.stats();
  return s.active + s.pending + s.succeeded + s.failed + s.timedOut + s.cancelled;
};

async function health(server) {
  const response = await fetch(`${server.baseUrl}/v1/health`);
  return response.json();
}

/** A server with `maxConcurrent` slots whose provider talks to the fake CLI. */
async function start(maxConcurrent, behaviour, { now, settings } = {}) {
  const harness = fakeProvider({ behaviour, settings, ...(now ? { now } : {}) });
  // The first readiness probe starts the CLI twice; do it before the clock starts.
  await harness.provider.status();
  const server = await startTestServer({ provider: harness.provider, config: { maxConcurrent } });
  return { harness, server };
}

function post(server, id, prompt, { signal, ...extra } = {}) {
  return server.post(requestBody({ request_id: id, prompt, ...extra }), { signal });
}

/** Sends one request and waits until the queue has accepted it, so arrival order is known. */
async function send(server, index, id, prompt, options) {
  const response = post(server, id, prompt, options);
  response.catch(() => {});
  await waitFor(() => accounted(server) > index, { label: `${id} to be accepted` });
  // Wrapped: an async function that returned the promise itself would wait for the response.
  return { response };
}

/** Samples how many fake CLI processes are alive at once. */
function watchAlive(pidDir) {
  let peak = 0;
  const timer = setInterval(() => {
    peak = Math.max(peak, readPids(pidDir).filter(isAlive).length);
  }, 5);
  return { stop: () => clearInterval(timer), peak: () => peak };
}

const pidOf = (harness, marker) => harness.prints().find((call) => call.stdin.includes(marker)).pid;
const markerOf = (call) => /MARK-(\w+)/.exec(call.stdin)[1];

async function expectDrained(server, harness) {
  await waitFor(() => server.app.queue.stats().active === 0, { label: 'every slot to free' });
  assert.equal(server.app.queue.stats().abandoned, 0);
  assert.ok(
    !harness.events.some((event) => event.event === 'claude_cli_lingering'),
    'every process was confirmed gone'
  );
}

test('the default is one execution at a time', async () => {
  const { server } = await start(undefined, {});
  try {
    assert.equal(server.app.queue.maxActive, 1);
    assert.equal((await health(server)).queue.max_active, 1);
  } finally {
    await server.close();
  }
});

for (const n of [1, 2, 3]) {
  describe(`fake CLI, concurrency ${n}`, () => {
    test('runs up to the limit at once, each with its own process, directory and output', async () => {
      const { harness, server } = await start(n, { run: 'success', echo: 'MARK-', delayMs: 800 });
      const watch = watchAlive(harness.files.pidDir);
      try {
        const total = n + 2;
        const responses = [];
        for (let index = 0; index < total; index += 1) {
          responses.push((await send(server, index, `r${index}`, `MARK-${index}`)).response);
        }

        // Saturated: every slot busy, the rest waiting in line, and health says so.
        await waitFor(() => server.app.queue.stats().active === n, { label: 'every slot to fill' });
        const body = await health(server);
        assert.deepEqual(
          {
            active: body.queue.active,
            max_active: body.queue.max_active,
            pending: body.queue.pending,
            capacity: body.queue.capacity,
            running: body.queue.running,
            length: body.queue.length,
          },
          { active: n, max_active: n, pending: 2, capacity: 16, running: true, length: 2 }
        );

        const results = await Promise.all(responses);
        watch.stop();

        results.forEach((result, index) => {
          assert.equal(result.status, 200, JSON.stringify(result.body));
          assert.equal(result.body.result.answer, `MARK-${index}`, 'each run answered its own input');
        });
        assert.equal(watch.peak(), n, 'at most `n` processes, and all `n` at once');

        const prints = harness.prints();
        assert.equal(prints.length, total);
        assert.equal(new Set(prints.map((call) => call.pid)).size, total, 'one process per request');
        assert.equal(readPids(harness.files.pidDir).length, total, 'one pid file per process');
        assert.equal(new Set(prints.map((call) => call.cwd)).size, total, 'one directory per run');
        for (const call of prints) {
          assert.match(call.cwd, /apayee-claude-/);
          assert.equal(existsSync(call.cwd), false, 'the directory was removed afterwards');
          assert.equal(call.stdin.match(/MARK-\d+/g).length, 1, 'no input from another request');
        }

        // The first `n` requests start before any later one; with one slot the whole order holds.
        const started = prints.map((call) => Number(markerOf(call)));
        assert.ok(started.slice(0, n).every((index) => index < n), JSON.stringify(started));
        if (n === 1) assert.deepEqual(started, [0, 1, 2]);

        await expectDrained(server, harness);
        assert.equal(server.app.queue.stats().succeeded, total);
      } finally {
        watch.stop();
        await server.close();
      }
    });

    test('cancelling one run kills only its process; the others and the line carry on', async () => {
      const { harness, server } = await start(n, {
        run: 'success',
        echo: 'MARK-',
        delayMs: 1_500,
        perPrompt: { HANGME: { run: 'hang', delayMs: 0 } },
      });
      try {
        const client = new AbortController();
        const { response: hung } = await send(server, 0, 'hung', 'HANGME MARK-hung', {
          signal: client.signal,
        });
        const others = [];
        for (let index = 1; index < n; index += 1) {
          others.push((await send(server, index, `o${index}`, `MARK-o${index}`)).response);
        }
        const { response: tail } = await send(server, n, 'tail', 'MARK-tail');

        await waitFor(() => readPids(harness.files.pidDir).length === n, { label: `${n} processes` });
        const hungPid = pidOf(harness, 'HANGME');
        const otherPids = others.map((_, index) => pidOf(harness, `MARK-o${index + 1}`));

        client.abort();
        await assert.rejects(hung);
        await waitFor(() => !isAlive(hungPid), { timeoutMs: 5_000, label: 'the cancelled process' });

        for (const pid of otherPids) assert.equal(isAlive(pid), true, 'a neighbour was left alone');
        await waitFor(() => server.app.queue.stats().cancelled === 1, { label: 'the cancellation' });

        const finished = await Promise.all([...others, tail]);
        finished.forEach((result, index) => {
          assert.equal(result.status, 200, JSON.stringify(result.body));
          const expected = index < others.length ? `MARK-o${index + 1}` : 'MARK-tail';
          assert.equal(result.body.result.answer, expected);
        });

        await expectDrained(server, harness);
        assert.equal(server.app.queue.stats().succeeded, n);
      } finally {
        await server.close();
      }
    });

    test('one run timing out leaves the others running', async () => {
      const { harness, server } = await start(n, {
        run: 'success',
        echo: 'MARK-',
        delayMs: 2_500,
        perPrompt: { HANGME: { run: 'hang', delayMs: 0 }, QUICK: { delayMs: 0 } },
      });
      try {
        const { response: hung } = await send(server, 0, 'hung', 'HANGME MARK-hung', {
          timeout_ms: 1_000,
        });
        const others = [];
        for (let index = 1; index < n; index += 1) {
          others.push((await send(server, index, `o${index}`, `MARK-o${index}`)).response);
        }

        await waitFor(() => readPids(harness.files.pidDir).length === n, { label: `${n} processes` });
        const hungPid = pidOf(harness, 'HANGME');
        const otherPids = others.map((_, index) => pidOf(harness, `MARK-o${index + 1}`));

        const timedOut = await hung;
        assert.equal(timedOut.status, 504);
        assert.equal(timedOut.body.error.code, 'PROVIDER_TIMEOUT');
        await waitFor(() => !isAlive(hungPid), { timeoutMs: 5_000, label: 'the timed-out process' });
        for (const pid of otherPids) assert.equal(isAlive(pid), true, 'a neighbour was left alone');
        await waitFor(() => server.app.queue.stats().timedOut === 1, { label: 'the timeout' });

        for (const result of await Promise.all(others)) {
          assert.equal(result.status, 200, JSON.stringify(result.body));
        }
        const after = await post(server, 'after', 'QUICK MARK-after');
        assert.equal(after.status, 200);
        assert.equal(after.body.result.answer, 'MARK-after');

        await expectDrained(server, harness);
      } finally {
        await server.close();
      }
    });

    test('a readiness probe can overlap running executions without disturbing them', async () => {
      let now = 1_000_000;
      const { harness, server } = await start(
        n,
        { run: 'success', echo: 'MARK-', delayMs: 2_000 },
        { now: () => now }
      );
      try {
        const runs = [];
        for (let index = 0; index < n; index += 1) {
          runs.push((await send(server, index, `r${index}`, `MARK-${index}`)).response);
        }
        await waitFor(() => readPids(harness.files.pidDir).length === n, { label: `${n} processes` });

        const probesBefore = { version: count(harness, 'version'), status: count(harness, 'status') };
        now += 61_000; // the cached "ready" has expired, so health starts the probe now
        const body = await health(server);

        assert.equal(body.provider, 'claude', 'the probe saw a ready provider');
        assert.equal(count(harness, 'version'), probesBefore.version + 1);
        assert.equal(count(harness, 'status'), probesBefore.status + 1);
        assert.equal(body.queue.active, n, 'the runs were still going when the probe finished');
        assert.equal(
          readPids(harness.files.pidDir).filter(isAlive).length,
          n,
          'the probe added no run, and no run was lost'
        );

        for (const result of await Promise.all(runs)) {
          assert.equal(result.status, 200, JSON.stringify(result.body));
        }
        await expectDrained(server, harness);
      } finally {
        await server.close();
      }
    });
  });
}
