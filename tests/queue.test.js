import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError } from '../src/errors.js';
import { RequestQueue } from '../src/queue/request-queue.js';

function newQueue(overrides = {}) {
  return new RequestQueue({
    maxPending: 10,
    maxQueueWaitMs: 5_000,
    abortGraceMs: 50,
    ...overrides,
  });
}

/** A unit of work the test finishes by hand, which honours its abort signal. */
function controllable() {
  const work = {};
  work.started = new Promise((resolve) => (work.markStarted = resolve));
  work.finished = new Promise((resolve, reject) => {
    work.finish = resolve;
    work.fail = reject;
  });
  work.run = (signal) => {
    work.signal = signal;
    work.markStarted();
    signal.addEventListener('abort', () => work.fail(signal.reason), { once: true });
    return work.finished;
  };
  return work;
}

function add(queue, id, run, extra = {}) {
  return queue.enqueue({ requestId: id, timeoutMs: 5_000, run, ...extra });
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ApiError, `expected ApiError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

function assertDrained(queue) {
  const { pending, active } = queue.stats();
  assert.deepEqual({ pending, active }, { pending: 0, active: 0 });
}

describe('FIFO order and concurrency', () => {
  test('runs requests in arrival order', async () => {
    const queue = newQueue();
    const order = [];
    const ids = Array.from({ length: 8 }, (_, index) => `r${index}`);

    const results = await Promise.all(
      ids.map((id, index) =>
        add(queue, id, async () => {
          order.push(id);
          // Later requests finish faster, so order cannot be an accident of timing.
          await delay(8 - index);
          return id;
        })
      )
    );

    assert.deepEqual(order, ids);
    assert.deepEqual(results, ids);
    assertDrained(queue);
  });

  test('never runs more than one at a time', async () => {
    const queue = newQueue();
    let running = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        add(queue, `r${index}`, async () => {
          running += 1;
          peak = Math.max(peak, running);
          await delay(2);
          running -= 1;
        })
      )
    );

    assert.equal(peak, 1);
  });

  test('a request that arrives later cannot overtake one that is waiting', async () => {
    const queue = newQueue();
    const first = controllable();
    const order = [];

    const running = add(queue, 'first', first.run);
    const second = add(queue, 'second', async () => order.push('second'));
    await first.started;

    const third = add(queue, 'third', async () => order.push('third'));

    first.finish();
    await Promise.all([running, second, third]);
    assert.deepEqual(order, ['second', 'third']);
  });

  test('concurrency stays at one across a timeout, for a provider that honours abort', async () => {
    const queue = newQueue();
    let running = 0;
    let peak = 0;

    const tracked = (ms) => async (signal) => {
      running += 1;
      peak = Math.max(peak, running);
      try {
        await delay(ms, undefined, { signal });
      } finally {
        await delay(5); // cleanup that takes real time after the abort
        running -= 1;
      }
    };

    const slow = queue.enqueue({ requestId: 'slow', timeoutMs: 10, run: tracked(1_000) });
    const next = add(queue, 'next', tracked(1));

    await rejectsWith(slow, 'PROVIDER_TIMEOUT');
    await next;
    assert.equal(peak, 1);
  });
});

describe('capacity and duplicates', () => {
  test('rejects beyond capacity without disturbing the queue', async () => {
    const queue = newQueue({ maxPending: 2 });
    const first = controllable();

    const accepted = [
      add(queue, 'active', first.run),
      add(queue, 'p1', async () => 'p1'),
      add(queue, 'p2', async () => 'p2'),
    ];
    await first.started;

    await rejectsWith(
      add(queue, 'p3', async () => 'p3'),
      'QUEUE_FULL'
    );
    assert.equal(queue.stats().pending, 2);
    assert.equal(queue.stats().rejected, 1);

    first.finish('active');
    assert.deepEqual(await Promise.all(accepted), ['active', 'p1', 'p2']);
  });

  test('zero pending capacity still runs a request when idle', async () => {
    const queue = newQueue({ maxPending: 0 });
    const first = controllable();

    const running = add(queue, 'a', first.run);
    await first.started;
    await rejectsWith(
      add(queue, 'b', async () => {}),
      'QUEUE_FULL'
    );

    first.finish('ok');
    assert.equal(await running, 'ok');
    assert.equal(await add(queue, 'c', async () => 'ok'), 'ok');
  });

  test('rejects an id that is active or pending, and accepts it again once finished', async () => {
    const queue = newQueue();
    const first = controllable();

    const active = add(queue, 'same', first.run);
    const pending = add(queue, 'waiting', async () => 'waiting');
    await first.started;

    await rejectsWith(
      add(queue, 'same', async () => {}),
      'DUPLICATE_REQUEST_ID'
    );
    await rejectsWith(
      add(queue, 'waiting', async () => {}),
      'DUPLICATE_REQUEST_ID'
    );

    first.finish('done');
    await Promise.all([active, pending]);
    assert.equal(await add(queue, 'same', async () => 'again'), 'again');
  });
});

describe('cancellation', () => {
  test('removes a cancelled pending request, which never runs', async () => {
    const queue = newQueue();
    const first = controllable();
    const client = new AbortController();
    let ran = false;

    const active = add(queue, 'active', first.run);
    const cancelled = add(queue, 'cancelled', async () => (ran = true), { signal: client.signal });
    const after = add(queue, 'after', async () => 'after');
    await first.started;

    client.abort();
    await rejectsWith(cancelled, 'REQUEST_CANCELLED');
    assert.equal(queue.stats().pending, 1);

    first.finish('active');
    assert.equal(await active, 'active');
    assert.equal(await after, 'after');
    assert.equal(ran, false);
    assert.equal(queue.stats().cancelled, 1);
    assertDrained(queue);
  });

  test('aborts the provider of a cancelled active request and moves on', async () => {
    const queue = newQueue();
    const first = controllable();
    const client = new AbortController();

    const active = add(queue, 'active', first.run, { signal: client.signal });
    const next = add(queue, 'next', async () => 'next');
    await first.started;

    client.abort();
    await rejectsWith(active, 'REQUEST_CANCELLED');
    assert.equal(first.signal.aborted, true);
    assert.equal(await next, 'next');
    assertDrained(queue);
  });

  test('rejects a request already cancelled when it arrives', async () => {
    const queue = newQueue();
    let ran = false;

    await rejectsWith(
      add(queue, 'gone', async () => (ran = true), { signal: AbortSignal.abort() }),
      'REQUEST_CANCELLED'
    );
    assert.equal(ran, false);
    assert.equal(queue.stats().rejected, 1);
  });

  test('leaves no listener on the client signal after finishing', async () => {
    const queue = newQueue();
    const client = new AbortController();
    const seen = [];
    const realAdd = client.signal.addEventListener.bind(client.signal);
    const realRemove = client.signal.removeEventListener.bind(client.signal);
    client.signal.addEventListener = (type, listener, options) => {
      seen.push(listener);
      realAdd(type, listener, options);
    };
    client.signal.removeEventListener = (type, listener, options) => {
      seen.splice(seen.indexOf(listener), 1);
      realRemove(type, listener, options);
    };

    await add(queue, 'a', async () => 'ok', { signal: client.signal });
    assert.equal(seen.length, 0);
  });
});

describe('timeouts', () => {
  test('a timed-out request aborts its provider and does not block the next', async () => {
    const queue = newQueue();
    const first = controllable();

    const slow = queue.enqueue({ requestId: 'slow', timeoutMs: 10, run: first.run });
    const next = add(queue, 'next', async () => 'next');

    await rejectsWith(slow, 'PROVIDER_TIMEOUT');
    assert.equal(first.signal.aborted, true);
    assert.equal(await next, 'next');
    assert.equal(queue.stats().timedOut, 1);
    assertDrained(queue);
  });

  test('a provider that reports its own timeout is counted as a timeout, not a failure', async () => {
    const queue = newQueue();

    await rejectsWith(
      add(queue, 'self-timeout', async () => {
        throw new ApiError('PROVIDER_TIMEOUT');
      }),
      'PROVIDER_TIMEOUT'
    );
    await rejectsWith(
      add(queue, 'other-failure', async () => {
        throw new ApiError('PROVIDER_UNAVAILABLE');
      }),
      'PROVIDER_UNAVAILABLE'
    );

    assert.equal(queue.stats().timedOut, 1);
    assert.equal(queue.stats().failed, 1);
    assertDrained(queue);
  });

  test('each request has its own timeout, which starts when it becomes active', async () => {
    const queue = newQueue();

    const first = queue.enqueue({
      requestId: 'first',
      timeoutMs: 1_000,
      run: () => delay(60).then(() => 'first'),
    });
    // Waits about 60 ms, longer than its own 30 ms budget, and must still run.
    const second = queue.enqueue({
      requestId: 'second',
      timeoutMs: 30,
      run: async () => 'second',
    });

    assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  });

  test('a request waiting longer than the queue limit is rejected and never runs', async () => {
    const queue = newQueue({ maxQueueWaitMs: 20 });
    const first = queue.enqueue({
      requestId: 'first',
      timeoutMs: 1_000,
      run: () => delay(80).then(() => 'first'),
    });
    let ran = false;
    const waiting = add(queue, 'waiting', async () => (ran = true));

    await rejectsWith(waiting, 'QUEUE_TIMEOUT');
    assert.equal(queue.stats().pending, 0);
    assert.equal(await first, 'first');
    assert.equal(ran, false);
  });

  test('a provider that ignores abort is released after the grace period', async () => {
    const queue = newQueue({ abortGraceMs: 20 });
    let finishLate;
    const stubborn = new Promise((resolve) => (finishLate = resolve));

    const stuck = queue.enqueue({ requestId: 'stuck', timeoutMs: 10, run: () => stubborn });
    const next = add(queue, 'next', async () => 'next');

    await rejectsWith(stuck, 'PROVIDER_TIMEOUT');
    assert.equal(await next, 'next');
    assert.equal(queue.stats().abandoned, 1);

    finishLate('too late');
    await delay(0);
    assert.equal(queue.stats().abandoned, 0);
    assertDrained(queue);
  });

  test('a provider that never settles leaves the queue usable', async () => {
    const queue = newQueue({ abortGraceMs: 10 });

    await rejectsWith(
      queue.enqueue({ requestId: 'forever', timeoutMs: 5, run: () => new Promise(() => {}) }),
      'PROVIDER_TIMEOUT'
    );
    assert.equal(await add(queue, 'after', async () => 'after'), 'after');
  });

  test('an abort that also races a late success still reports the abort', async () => {
    const queue = newQueue();
    const slow = queue.enqueue({
      requestId: 'slow',
      timeoutMs: 5,
      run: () => delay(15).then(() => 'late success'),
    });

    await rejectsWith(slow, 'PROVIDER_TIMEOUT');
    assert.equal(queue.stats().succeeded, 0);
  });
});

describe('recovery and counters', () => {
  test('recovers after rejection, a synchronous throw, and a late rejection', async () => {
    const queue = newQueue({ abortGraceMs: 5 });
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    await assert.rejects(
      add(queue, 'rejects', async () => {
        throw new Error('boom');
      }),
      /boom/
    );
    await assert.rejects(
      add(queue, 'throws', () => {
        throw new Error('sync');
      }),
      /sync/
    );

    let failLate;
    const late = new Promise((_, reject) => (failLate = reject));
    await rejectsWith(
      queue.enqueue({ requestId: 'late', timeoutMs: 1, run: () => late }),
      'PROVIDER_TIMEOUT'
    );
    failLate(new Error('late failure'));
    await delay(5);

    process.off('unhandledRejection', onUnhandled);
    assert.deepEqual(unhandled, []);
    assert.equal(await add(queue, 'after', async () => 'after'), 'after');
  });

  test('counters are exact after every kind of outcome', async () => {
    const queue = newQueue({ maxPending: 1 });
    const client = new AbortController();
    const first = controllable();

    await add(queue, 'ok', async () => 'ok');
    await assert.rejects(
      add(queue, 'fail', async () => {
        throw new Error('x');
      })
    );
    await rejectsWith(
      queue.enqueue({
        requestId: 'timeout',
        timeoutMs: 1,
        run: (s) => delay(1_000, null, { signal: s }),
      }),
      'PROVIDER_TIMEOUT'
    );

    const active = add(queue, 'cancel', first.run, { signal: client.signal });
    await first.started;
    const pending = add(queue, 'pending', async () => 'pending');
    await rejectsWith(
      add(queue, 'full', async () => {}),
      'QUEUE_FULL'
    );

    client.abort();
    await rejectsWith(active, 'REQUEST_CANCELLED');
    await pending;

    assert.deepEqual(queue.stats(), {
      pending: 0,
      active: 0,
      abandoned: 0,
      succeeded: 2,
      failed: 1,
      timedOut: 1,
      cancelled: 1,
      rejected: 1,
    });
  });
});

describe('close', () => {
  test('settles every request and refuses new ones', async () => {
    const queue = newQueue();
    const first = controllable();

    const active = add(queue, 'active', first.run);
    const pending = [add(queue, 'p1', async () => {}), add(queue, 'p2', async () => {})];
    await first.started;

    const outcomes = Promise.allSettled([active, ...pending]);
    await queue.close();

    for (const outcome of await outcomes) {
      assert.equal(outcome.status, 'rejected');
      assert.equal(outcome.reason.code, 'SERVICE_SHUTTING_DOWN');
    }
    assert.equal(first.signal.aborted, true);
    await rejectsWith(
      add(queue, 'late', async () => {}),
      'SERVICE_SHUTTING_DOWN'
    );
    assertDrained(queue);
  });

  test('resolves even when the active provider ignores abort', async () => {
    const queue = newQueue({ abortGraceMs: 10 });
    const stuck = add(queue, 'stuck', () => new Promise(() => {}));

    await queue.close();
    await rejectsWith(stuck, 'SERVICE_SHUTTING_DOWN');
  });

  test('resolves immediately when idle', async () => {
    await newQueue().close();
  });
});
