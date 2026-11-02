import { setTimeout as delay } from 'node:timers/promises';
import { compileClientSchema } from '../../validation/json-schema.js';
import { Provider } from '../provider.js';
import { FIXTURES } from './fixtures.js';
import { synthesize } from './synthesize.js';

const TASKS = new Set(['understand_prd', 'generate_testcases', 'generic']);

/**
 * A provider that answers without any model, deterministically.
 *
 * It exists to prove the service contract, the queue and client integrations before
 * a real inference provider is involved. The same request always gets the same
 * answer: the task's fixture when it satisfies the client's schema, otherwise a
 * minimal value built from the schema itself.
 *
 * The constructor options are for tests only. The registry constructs this class
 * with no options, and neither an HTTP request nor an environment variable can set
 * them, so clients cannot trigger delays or failures.
 */
export class MockProvider extends Provider {
  /**
   * @param {object} [testOptions]
   * @param {number|((request: object) => number)} [testOptions.latencyMs]
   * @param {Error|((request: object) => Error|undefined)} [testOptions.failWith]
   * @param {unknown|((request: object) => unknown)} [testOptions.output]  replaces the answer
   * @param {boolean} [testOptions.ignoreAbort]  misbehave by not honouring the signal
   * @param {(request: object) => void} [testOptions.onCall]
   */
  constructor(testOptions = {}) {
    super({ name: 'mock' });
    this.testOptions = testOptions;
  }

  supportsTask(task) {
    return TASKS.has(task);
  }

  async generate(request) {
    const { latencyMs, failWith, ignoreAbort, onCall } = this.testOptions;
    onCall?.(request);

    request.signal?.throwIfAborted();

    const latency = typeof latencyMs === 'function' ? latencyMs(request) : latencyMs;
    if (latency) await delay(latency, undefined, ignoreAbort ? {} : { signal: request.signal });

    const failure = typeof failWith === 'function' ? failWith(request) : failWith;
    if (failure) throw failure;

    return { data: this.#answer(request), usage: { input_tokens: 0, output_tokens: 0 } };
  }

  #answer(request) {
    if ('output' in this.testOptions) {
      const { output } = this.testOptions;
      return typeof output === 'function' ? output(request) : output;
    }

    const fixture = FIXTURES[request.task]?.(request);
    if (fixture !== undefined && compileClientSchema(request.schema)(fixture).valid) return fixture;

    return synthesize(request.schema);
  }
}
