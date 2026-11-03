import { isIPv4 } from 'node:net';
import { isAbsolute } from 'node:path';
import { isDeniedEnvironmentName } from './providers/claude/environment.js';

/**
 * Runtime configuration, read once at startup from the environment.
 *
 * Invalid values stop the service instead of falling back to a default. A typo
 * in APAYEE_HOST or APAYEE_MAX_TIMEOUT_MS should be noticed at boot, not
 * discovered later as a service listening somewhere nobody intended.
 */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Node's timers overflow above this and fire immediately. */
const MAX_TIMER_MS = 2_147_483_647;

/** Upper bound for APAYEE_MAX_CONCURRENT. Raising it needs measurements, not just a number. */
export const MAX_CONCURRENT_LIMIT = 3;

const MIN_TOKEN_LENGTH = 32;
const MIN_TOKEN_DISTINCT_CHARS = 8;
const PLACEHOLDER_TOKEN = /change.?me|replace.?me|your.?token|example|placeholder/i;

const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

function intFrom(env, name, fallback, { min = 0, max = MAX_TIMER_MS } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;

  const value = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function booleanFrom(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ConfigError(`${name} must be 'true' or 'false'.`);
}

export function isLoopbackHost(host) {
  const normalized = host.trim().toLowerCase();
  if (normalized === 'localhost' || normalized === '::1') return true;

  const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice('::ffff:'.length) : normalized;
  return isIPv4(ipv4) && ipv4.startsWith('127.');
}

/** @returns {string|null} why the token is unacceptable; never quotes the token */
function tokenWeakness(token) {
  if (token.length < MIN_TOKEN_LENGTH) return `shorter than ${MIN_TOKEN_LENGTH} characters`;
  if (/\s/.test(token)) return 'contains whitespace';
  if (new Set(token).size < MIN_TOKEN_DISTINCT_CHARS) return 'too repetitive';
  if (PLACEHOLDER_TOKEN.test(token)) return 'looks like a placeholder';
  return null;
}

/** Aliases such as `sonnet` or `opus[1m]`, and full model names. Never reaches a shell. */
const CLAUDE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/;

/**
 * Settings of the experimental Claude Code CLI provider.
 *
 * Read on their own so the login and status scripts can use them before the rest of
 * the service is configured. Everything defaults to "off": the provider does nothing
 * until its owner has enabled it and has confirmed the plan by hand.
 */
export function loadClaudeSettings(env = process.env) {
  const cliPath = (env.APAYEE_CLAUDE_CLI_PATH ?? '').trim() || null;
  if (cliPath && !isAbsolute(cliPath)) {
    throw new ConfigError('APAYEE_CLAUDE_CLI_PATH must be an absolute path to the claude program.');
  }

  const model = (env.APAYEE_CLAUDE_MODEL ?? '').trim() || null;
  if (model && !CLAUDE_MODEL.test(model)) {
    throw new ConfigError('APAYEE_CLAUDE_MODEL is not a valid model name or alias.');
  }

  return {
    experimental: booleanFrom(env, 'APAYEE_CLAUDE_EXPERIMENTAL', false),
    // The owner's own statement that the account is the plan they mean. Apayee cannot
    // verify a plan: neither `claude auth status` nor `/status` proves it.
    subscriptionConfirmed: booleanFrom(env, 'APAYEE_CLAUDE_SUBSCRIPTION_CONFIRMED', false),
    cliPath,
    model,
    // A ceiling on one CLI run. A request's own timeout_ms applies as well; the shorter wins.
    timeoutMs: intFrom(env, 'APAYEE_CLAUDE_TIMEOUT_MS', 300_000, { min: 1 }),
    // Passed to MAX_STRUCTURED_OUTPUT_RETRIES: attempts the CLI makes to get a reply that
    // matches the schema. 1 means no internal retry.
    structuredOutputAttempts: intFrom(env, 'APAYEE_CLAUDE_STRUCTURED_OUTPUT_ATTEMPTS', 1, {
      min: 1,
      max: 5,
    }),
    // Names of extra variables the CLI may inherit, e.g. HTTPS_PROXY on a corporate network.
    passthroughEnv: passthroughNamesFrom(env),
  };
}

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Everything else is withheld from the CLI (see providers/claude/environment.js). An
 * operator can approve a name on purpose, but never one that carries a credential or
 * redirects authentication or billing, and never one of Apayee's own settings.
 */
function passthroughNamesFrom(env) {
  const names = (env.APAYEE_CLAUDE_PASSTHROUGH_ENV ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

  for (const name of names) {
    if (!ENVIRONMENT_NAME.test(name)) {
      throw new ConfigError('APAYEE_CLAUDE_PASSTHROUGH_ENV must be a comma-separated list of variable names.');
    }
    if (isDeniedEnvironmentName(name) || name.toUpperCase().startsWith('APAYEE_')) {
      throw new ConfigError(`APAYEE_CLAUDE_PASSTHROUGH_ENV cannot approve ${name.toUpperCase()}.`);
    }
  }
  return [...new Set(names)];
}

export function loadConfig(env = process.env) {
  const host = (env.APAYEE_HOST ?? '').trim() || '127.0.0.1';
  const allowRemote = booleanFrom(env, 'APAYEE_ALLOW_REMOTE', false);
  const authToken = env.APAYEE_AUTH_TOKEN || null;

  // Checked whenever a token is set, not only in remote mode: a weak token on
  // loopback is the one that gets copied to the LAN deployment later.
  const weakness = authToken && tokenWeakness(authToken);
  if (weakness) throw new ConfigError(`APAYEE_AUTH_TOKEN is not acceptable: ${weakness}.`);

  const remote = !isLoopbackHost(host);
  if (remote && !allowRemote) {
    throw new ConfigError(
      `APAYEE_HOST is '${host}', which is not a loopback address. Set APAYEE_ALLOW_REMOTE=true to allow remote access deliberately.`
    );
  }
  if (remote && !authToken) {
    throw new ConfigError('Remote access requires APAYEE_AUTH_TOKEN to be set.');
  }

  const provider = (env.APAYEE_PROVIDER ?? '').trim() || 'mock';

  // The Claude provider spends its owner's subscription. It is a private, single-owner
  // experiment, so it never listens beyond this machine, and it needs the token so that
  // only the owner's own applications can use it.
  if (provider === 'claude') {
    if (remote) {
      throw new ConfigError(
        'APAYEE_PROVIDER=claude is owner-only and must listen on a loopback address.'
      );
    }
    if (!authToken) {
      throw new ConfigError(
        'APAYEE_PROVIDER=claude requires APAYEE_AUTH_TOKEN, so that only your own applications can use your subscription.'
      );
    }
  }

  const defaultTimeoutMs = intFrom(env, 'APAYEE_DEFAULT_TIMEOUT_MS', 180_000, { min: 1 });
  const maxTimeoutMs = intFrom(env, 'APAYEE_MAX_TIMEOUT_MS', 600_000, { min: 1 });
  if (defaultTimeoutMs > maxTimeoutMs) {
    throw new ConfigError('APAYEE_DEFAULT_TIMEOUT_MS must not exceed APAYEE_MAX_TIMEOUT_MS.');
  }

  const logLevel = (env.APAYEE_LOG_LEVEL ?? '').trim() || 'info';
  if (!LOG_LEVELS.has(logLevel)) {
    throw new ConfigError(`APAYEE_LOG_LEVEL must be one of: ${[...LOG_LEVELS].join(', ')}.`);
  }

  return {
    host,
    port: intFrom(env, 'APAYEE_PORT', 4100, { max: 65_535 }),
    allowRemote,
    authToken,
    provider,
    claude: loadClaudeSettings(env),
    // 1 is the tested, default behaviour. Above 1 the CLI processes share one sign-in; see
    // docs/CLAUDE_PROVIDER.md before raising it.
    maxConcurrent: intFrom(env, 'APAYEE_MAX_CONCURRENT', 1, { min: 1, max: MAX_CONCURRENT_LIMIT }),
    maxQueueSize: intFrom(env, 'APAYEE_MAX_QUEUE_SIZE', 16),
    maxQueueWaitMs: intFrom(env, 'APAYEE_MAX_QUEUE_WAIT_MS', 600_000, { min: 1 }),
    defaultTimeoutMs,
    maxTimeoutMs,
    abortGraceMs: intFrom(env, 'APAYEE_ABORT_GRACE_MS', 2_000),
    shutdownTimeoutMs: intFrom(env, 'APAYEE_SHUTDOWN_TIMEOUT_MS', 10_000, { min: 1 }),
    maxBodyBytes: intFrom(env, 'APAYEE_MAX_BODY_BYTES', 10_485_760, { min: 1 }),
    maxSchemaBytes: intFrom(env, 'APAYEE_MAX_SCHEMA_BYTES', 262_144, { min: 1 }),
    logLevel,
  };
}
