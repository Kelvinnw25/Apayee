/**
 * The contract every provider implements.
 *
 * One method. A provider takes an instruction, a prompt and a JSON Schema and
 * returns parsed JSON. Apayee validates that JSON afterwards, so a provider's
 * promise to follow the schema is never taken on trust.
 *
 * Obligations of an implementation:
 *
 *   Honour `signal`. Stop the work and reject promptly when it aborts, including
 *   any subprocess or socket it holds. A provider that ignores the signal is
 *   released from its queue slot after a grace period and keeps running in the
 *   background, which breaks the one-at-a-time guarantee for as long as it runs.
 *
 *   Return parsed JSON in `data`: an object or an array, never a string, and never
 *   Markdown-wrapped JSON.
 *
 *   Fail with ApiError('PROVIDER_UNAVAILABLE', safeMessage). Any other thrown error
 *   reaches the client as that same code with its message discarded, because vendor
 *   errors can quote the request. Never put prompt content in a message.
 *
 *   Stay stateless between calls. Clients carry their own context in the prompt.
 */
export class Provider {
  /** @param {{name: string}} descriptor */
  constructor({ name }) {
    this.name = name;
  }

  /**
   * Whether this provider can take work right now. Health reports the provider's
   * name only while this says `ready`, so a provider that needs a login, a
   * configuration step or an opt-in is never presented to a client as available
   * before it is. Must not throw and must not send a generation request.
   *
   * @returns {Promise<{ready: boolean, state: string, reason?: string}>}
   */
  async status() {
    return { ready: true, state: 'ready' };
  }

  /** @returns {boolean} whether requests for this task should be accepted at all */
  // eslint-disable-next-line no-unused-vars
  supportsTask(_task) {
    return true;
  }

  /**
   * @param {object} _request
   * @param {string} _request.system     instruction that frames the task
   * @param {string} _request.prompt     the input to work from
   * @param {object} _request.schema     JSON Schema the result must match
   * @param {string} _request.task       the client's task identifier
   * @param {AbortSignal} _request.signal
   * @param {number} _request.timeoutMs  execution budget; the queue enforces it regardless
   * @returns {Promise<{data: object|unknown[], usage?: object}>}
   */
  // eslint-disable-next-line no-unused-vars
  async generate(_request) {
    throw new Error(`${this.constructor.name} must implement generate().`);
  }
}
