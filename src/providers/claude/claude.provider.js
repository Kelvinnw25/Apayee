import { ConfigError } from '../../config.js';
import { ApiError } from '../../errors.js';
import { Provider } from '../provider.js';
import { runCli } from './cli.js';
import { childEnvironment } from './environment.js';
import {
  buildPrintArgs,
  buildPrintInput,
  MAX_SCHEMA_ARGUMENT_CHARS,
  STRUCTURED_OUTPUT_ATTEMPTS_VARIABLE,
} from './invocation.js';
import { checkStatic, probe } from './readiness.js';
import { interpretRun } from './result.js';
import { withIsolatedDirectory } from './workdir.js';

/** How long a "ready" probe is trusted. The probe starts the CLI twice, so it is not run per request. */
const READY_TTL_MS = 60_000;

/**
 * After a probe says "not ready", the next one waits longer each time the answer stays the
 * same, up to the last value. A QATOOL page left open polls health every few seconds; this
 * keeps that from starting two CLI processes each time.
 */
const NOT_READY_BACKOFF_MS = [15_000, 30_000, 60_000];

function abortable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new ApiError('REQUEST_CANCELLED'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** A short excerpt for the owner's terminal only; control characters removed. */
function excerpt(text) {
  return String(text ?? '')
    .replace(/[^\x20-\x7e]+/g, ' ')
    .trim()
    .slice(0, 300);
}

/**
 * Generates through the official Claude Code CLI, using the owner's own signed-in
 * Claude subscription.
 *
 * Experimental, private and single-owner. Authentication belongs entirely to the CLI:
 * this class never sees, stores or forwards a credential, and it never falls back to
 * another provider. If it is not ready it says so and does nothing.
 *
 * Each request is a fresh process in an empty directory with no tools, no MCP servers
 * and no saved session, and an environment built from an allowlist. Apayee never retries.
 * The CLI itself may: it re-prompts when its reply fails the schema, bounded here by
 * MAX_STRUCTURED_OUTPUT_RETRIES (default one attempt), and a run can take several model
 * turns. `num_turns` is reported so a request is never mistaken for one turn.
 */
export class ClaudeProvider extends Provider {
  #settings;
  #env;
  #cli;
  #onEvent;
  #now;
  #cache = null;
  #inflight = null;
  #notReadyStreak = 0;

  /**
   * @param {object} options
   * @param {object} options.config                   service configuration (`config.claude` is used)
   * @param {object} [options.env]                    defaults to process.env
   * @param {{file: string, args: string[]}} [options.cli]  injected in tests
   * @param {(event: object) => void} [options.onEvent]     metadata-only events for the log
   * @param {() => number} [options.now]                    clock, injected in tests
   */
  constructor({ config, env = process.env, cli, onEvent, now = Date.now } = {}) {
    super({ name: 'claude' });

    if (!config?.claude) {
      throw new ConfigError('The claude provider needs the service configuration.');
    }
    this.#settings = config.claude;
    this.#env = env;
    this.#cli = cli;
    this.#onEvent = onEvent;
    this.#now = now;
  }

  /** @returns {Promise<{ready: boolean, state: string, reason?: string, cli_version?: string}>} */
  async status() {
    const evaluation = await this.#evaluation();
    return {
      ready: evaluation.ready,
      state: evaluation.state,
      ...(evaluation.reason ? { reason: evaluation.reason } : {}),
      ...(evaluation.details?.cliVersion ? { cli_version: evaluation.details.cliVersion } : {}),
    };
  }

  /** Stage 1 starts nothing and is evaluated every time; stage 2 is cached and single-flight. */
  #evaluation() {
    let stage;
    try {
      stage = checkStatic({ settings: this.#settings, env: this.#env, cli: this.#cli });
    } catch {
      return Promise.resolve({
        ready: false,
        state: 'status_unavailable',
        reason: 'The Claude provider could not check its own state.',
        details: {},
      });
    }
    if (!stage.ok) return Promise.resolve(stage.result);

    if (this.#cache && this.#now() < this.#cache.until) return Promise.resolve(this.#cache.value);

    this.#inflight ??= probe({ settings: this.#settings, env: this.#env, command: stage.command })
      .then((value) => {
        let ttl = READY_TTL_MS;
        if (value.ready) {
          this.#notReadyStreak = 0;
        } else {
          this.#notReadyStreak += 1;
          ttl = NOT_READY_BACKOFF_MS[Math.min(this.#notReadyStreak, NOT_READY_BACKOFF_MS.length) - 1];
        }
        this.#cache = { value, until: this.#now() + ttl };
        return value;
      })
      .finally(() => {
        this.#inflight = null;
      });
    return this.#inflight;
  }

  #forget() {
    this.#cache = null;
  }

  #emit(level, event) {
    this.#onEvent?.({ level, ...event });
  }

  async generate({ system, prompt, schema, signal, timeoutMs }) {
    const status = await abortable(this.status(), signal);
    if (!status.ready) {
      throw new ApiError('PROVIDER_NOT_READY', `The Claude provider is not ready: ${status.reason}`);
    }

    // Checked again on every request: a cached answer must not outlive a change that would
    // send this run to an API key, another login or a different CLI.
    const stage = checkStatic({ settings: this.#settings, env: this.#env, cli: this.#cli });
    if (!stage.ok) {
      this.#forget();
      throw new ApiError('PROVIDER_NOT_READY', `The Claude provider is not ready: ${stage.result.reason}`);
    }
    const command = stage.command;

    if (JSON.stringify(schema).length > MAX_SCHEMA_ARGUMENT_CHARS) {
      throw new ApiError(
        'INVALID_SCHEMA',
        `The schema is too large for the Claude CLI provider (limit ${MAX_SCHEMA_ARGUMENT_CHARS} characters).`
      );
    }

    const budget = Math.min(timeoutMs, this.#settings.timeoutMs);
    const startedAt = performance.now();

    let run;
    try {
      run = await withIsolatedDirectory((cwd) =>
        runCli({
          file: command.file,
          args: [...command.args, ...buildPrintArgs({ schema, model: this.#settings.model })],
          input: buildPrintInput({ system, prompt }),
          env: childEnvironment(this.#env, {
            approved: this.#settings.passthroughEnv,
            extra: {
              [STRUCTURED_OUTPUT_ATTEMPTS_VARIABLE]: String(this.#settings.structuredOutputAttempts),
            },
          }),
          cwd,
          signal,
          timeoutMs: budget,
        })
      );
    } catch {
      this.#forget();
      throw new ApiError('PROVIDER_UNAVAILABLE', 'The claude program could not be started.');
    }

    if (run.lingering) {
      // The process did not confirm it had stopped. Say so instead of reporting a clean exit.
      this.#emit('warn', {
        event: 'claude_cli_lingering',
        reason: run.aborted ? 'aborted' : run.timedOut ? 'timed_out' : 'truncated',
      });
    }

    // Once aborted, the queue decides the outcome; this only has to stop promptly.
    if (run.aborted) {
      throw signal?.reason instanceof ApiError ? signal.reason : new ApiError('REQUEST_CANCELLED');
    }
    if (run.timedOut) throw new ApiError('PROVIDER_TIMEOUT');
    if (run.truncated) {
      throw new ApiError(
        'INVALID_PROVIDER_RESPONSE',
        'The Claude CLI produced more output than Apayee will read.'
      );
    }

    const result = interpretRun(run);
    if (!result.ok) throw this.#failure(result, run);

    // Counts only. `num_turns` above 1 means the CLI took more than one model turn.
    this.#emit('info', {
      event: 'claude_cli_finished',
      num_turns: result.numTurns,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      duration_ms: Math.round(performance.now() - startedAt),
    });

    return { data: result.data, usage: result.usage };
  }

  #failure(result, run) {
    const { kind } = result;

    // Counts and a classification only. The CLI's own text can quote the prompt.
    this.#emit('warn', {
      event: 'claude_cli_failed',
      kind,
      exit_code: run.code,
      exit_signal: run.exitSignal,
      stdout_bytes: run.stdoutBytes,
      stderr_bytes: run.stderrBytes,
      api_error_status: result.apiErrorStatus,
      num_turns: result.numTurns,
    });

    let error;
    switch (kind) {
      case 'not_authenticated':
        this.#forget();
        error = new ApiError(
          'PROVIDER_NOT_READY',
          'The Claude CLI is not signed in, or its login expired. Run "npm run claude:login" on the Apayee host.'
        );
        break;
      case 'usage_limit':
        error = new ApiError(
          'PROVIDER_RATE_LIMITED',
          "The Claude subscription's usage limit (session, weekly or model) has been reached. Retrying now will not help; wait for the limit to reset."
        );
        break;
      case 'rate_limited':
        error = new ApiError(
          'PROVIDER_RATE_LIMITED',
          'Claude is temporarily limiting requests. Wait briefly, then retry.'
        );
        break;
      case 'overloaded':
        // Anthropic documents that a 529 does not count against a usage limit.
        error = new ApiError(
          'PROVIDER_UNAVAILABLE',
          "Claude's API is temporarily overloaded or unavailable. This does not use up your usage limit. Retry shortly."
        );
        break;
      case 'api_timeout':
        error = new ApiError('PROVIDER_TIMEOUT', 'Claude did not respond in time.');
        break;
      case 'max_turns':
        error = new ApiError(
          'INVALID_PROVIDER_RESPONSE',
          'The Claude CLI stopped at its turn limit before producing a valid answer.'
        );
        break;
      case 'schema_retries':
        error = new ApiError(
          'INVALID_PROVIDER_RESPONSE',
          'The Claude CLI could not produce output that satisfies the schema within the allowed attempts.'
        );
        break;
      case 'no_structured_output':
        error = new ApiError(
          'INVALID_PROVIDER_RESPONSE',
          'The Claude CLI returned no structured output.'
        );
        break;
      case 'malformed_output':
        error = new ApiError(
          'INVALID_PROVIDER_RESPONSE',
          'The Claude CLI returned output that is not valid JSON.'
        );
        break;
      default:
        error = new ApiError(
          'PROVIDER_UNAVAILABLE',
          `The Claude CLI exited with an error (code ${run.code ?? 'none'}).`
        );
    }

    // For the owner's own terminal (the smoke test prints them). Not enumerable, so they are
    // never serialized into a response or a log line.
    Object.defineProperty(error, 'diagnostic', { value: excerpt(run.stderr), enumerable: false });
    Object.defineProperty(error, 'claudeKind', { value: kind, enumerable: false });
    Object.defineProperty(error, 'numTurns', { value: result.numTurns, enumerable: false });
    return error;
  }
}
