import { ApiError } from '../errors.js';

/**
 * In-memory FIFO queue with exactly one active execution.
 *
 *   enqueue -> pending (bounded in size and in wait) -> active -> settled
 *
 * Every enqueue promise settles exactly once, on every path, and every path goes
 * through #settle, which is the only place timers, listeners and the id set are
 * cleaned up. That single exit is what keeps the counters and the id set accurate.
 *
 * The timeout budget covers execution only and starts when the request becomes
 * active, so requests ahead of it in the queue cannot consume it. Time spent
 * waiting has its own separate bound.
 *
 * Aborting an active request waits briefly for the work to stop. That keeps
 * concurrency at one for any provider that honours its signal, while the grace
 * limit means a provider that ignores it cannot hold the queue. Work that outlives
 * the grace period is counted as `abandoned` in stats.
 *
 * Nothing is retried, and nothing survives a restart. Clients own their workflow
 * state and can resend.
 */
export class RequestQueue {
  #pending = [];
  #active = null;
  #ids = new Set();
  #closed = false;
  #idleWaiters = [];
  #abandoned = 0;
  #counters = { succeeded: 0, failed: 0, timedOut: 0, cancelled: 0, rejected: 0 };

  /**
   * @param {object} options
   * @param {number} options.maxPending      requests allowed to wait behind the active one
   * @param {number} options.maxQueueWaitMs
   * @param {number} [options.abortGraceMs]  how long aborted work gets to stop
   * @param {{warn: Function}} [options.logger]
   */
  constructor({ maxPending, maxQueueWaitMs, abortGraceMs = 2_000, logger }) {
    this.maxPending = maxPending;
    this.maxQueueWaitMs = maxQueueWaitMs;
    this.abortGraceMs = abortGraceMs;
    this.logger = logger;
  }

  get closed() {
    return this.#closed;
  }

  stats() {
    return {
      pending: this.#pending.length,
      active: this.#active ? 1 : 0,
      abandoned: this.#abandoned,
      ...this.#counters,
    };
  }

  /**
   * @template T
   * @param {object} request
   * @param {string} request.requestId
   * @param {number} request.timeoutMs      execution budget, starting when active
   * @param {AbortSignal} [request.signal]  the client's cancellation
   * @param {(signal: AbortSignal) => Promise<T>} request.run
   * @returns {Promise<T>}
   */
  enqueue({ requestId, timeoutMs, signal, run }) {
    const refusal = this.#refusalFor(requestId, signal);
    if (refusal) {
      this.#counters.rejected += 1;
      return Promise.reject(refusal);
    }

    return new Promise((resolve, reject) => {
      const entry = { requestId, timeoutMs, signal, run, resolve, reject, settled: false };

      entry.onClientAbort = () => this.#cancel(entry, signal.reason);
      signal?.addEventListener('abort', entry.onClientAbort, { once: true });

      entry.waitTimer = setTimeout(() => {
        this.#settle(entry, 'timedOut', { error: new ApiError('QUEUE_TIMEOUT') });
      }, this.maxQueueWaitMs);

      this.#ids.add(requestId);
      this.#pending.push(entry);
      this.#pump();
    });
  }

  /**
   * Stops the queue for good: pending requests are rejected, the active one is
   * aborted. Resolves once nothing is left active, including the grace period.
   */
  close() {
    this.#closed = true;
    const shuttingDown = () => new ApiError('SERVICE_SHUTTING_DOWN');

    for (const entry of [...this.#pending]) {
      this.#settle(entry, 'cancelled', { error: shuttingDown() });
    }
    if (!this.#active) return Promise.resolve();

    const idle = new Promise((resolve) => this.#idleWaiters.push(resolve));
    this.#abortActive(this.#active, shuttingDown(), 'cancelled');
    return idle;
  }

  #refusalFor(requestId, signal) {
    if (this.#closed) return new ApiError('SERVICE_SHUTTING_DOWN');
    if (signal?.aborted) return cancellationFrom(signal.reason);
    if (this.#ids.has(requestId)) return new ApiError('DUPLICATE_REQUEST_ID');
    if (this.#active && this.#pending.length >= this.maxPending) return new ApiError('QUEUE_FULL');
    return null;
  }

  #pump() {
    if (this.#active || this.#closed) return;

    const next = this.#pending.shift();
    if (next) this.#start(next);
  }

  #start(entry) {
    this.#active = entry;
    clearTimeout(entry.waitTimer);

    entry.controller = new AbortController();
    entry.execTimer = setTimeout(() => {
      this.#abortActive(entry, new ApiError('PROVIDER_TIMEOUT'), 'timedOut');
    }, entry.timeoutMs);

    // A provider that throws synchronously is handled the same as one that rejects.
    let work;
    try {
      work = Promise.resolve(entry.run(entry.controller.signal));
    } catch (error) {
      work = Promise.reject(error);
    }

    work.then(
      (value) => this.#onWorkDone(entry, { value }),
      (error) => this.#onWorkDone(entry, { error })
    );
  }

  #onWorkDone(entry, outcome) {
    if (entry.abandoned) {
      this.#abandoned -= 1;
      this.logger?.warn(
        { event: 'abandoned_work_finished', request_id: entry.requestId },
        'Provider work finished long after it was aborted.'
      );
      return;
    }

    // Once aborted, the abort decides the outcome. Whatever the work returned or
    // threw while stopping is irrelevant.
    if (entry.abortOutcome) {
      this.#settle(entry, entry.abortOutcome.counter, { error: entry.abortOutcome.error });
    } else if ('error' in outcome) {
      // A provider that enforces its own, shorter ceiling reports it as a timeout, and
      // it is counted as one rather than as a generic failure.
      const counter = outcome.error?.code === 'PROVIDER_TIMEOUT' ? 'timedOut' : 'failed';
      this.#settle(entry, counter, outcome);
    } else {
      this.#settle(entry, 'succeeded', outcome);
    }
  }

  #cancel(entry, reason) {
    const error = cancellationFrom(reason);

    if (entry === this.#active) {
      this.#abortActive(entry, error, 'cancelled');
    } else {
      this.#settle(entry, 'cancelled', { error });
    }
  }

  #abortActive(entry, error, counter) {
    if (entry.abortOutcome || entry.settled) return;

    clearTimeout(entry.execTimer);
    entry.abortOutcome = { error, counter };

    entry.graceTimer = setTimeout(() => {
      entry.abandoned = true;
      this.#abandoned += 1;
      this.logger?.warn(
        { event: 'provider_ignored_abort', request_id: entry.requestId },
        'Provider did not stop within the abort grace period; releasing the queue slot.'
      );
      this.#settle(entry, counter, { error });
    }, this.abortGraceMs);

    entry.controller.abort(error);
  }

  #settle(entry, counter, { value, error }) {
    if (entry.settled) return;
    entry.settled = true;

    clearTimeout(entry.waitTimer);
    clearTimeout(entry.execTimer);
    clearTimeout(entry.graceTimer);
    entry.signal?.removeEventListener('abort', entry.onClientAbort);
    this.#ids.delete(entry.requestId);

    if (entry === this.#active) {
      this.#active = null;
    } else {
      this.#pending.splice(this.#pending.indexOf(entry), 1);
    }

    this.#counters[counter] += 1;
    if (error === undefined) entry.resolve(value);
    else entry.reject(error);

    this.#pump();

    if (!this.#active && this.#idleWaiters.length > 0) {
      for (const resolve of this.#idleWaiters.splice(0)) resolve();
    }
  }
}

function cancellationFrom(reason) {
  return reason instanceof ApiError ? reason : new ApiError('REQUEST_CANCELLED');
}
