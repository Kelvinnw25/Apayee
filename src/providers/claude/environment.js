/**
 * What the Claude Code CLI may inherit from Apayee's environment, and what stops it.
 *
 * The point of this provider is the owner's existing Claude subscription login. Anything
 * in the environment that supplies a different credential, routes requests elsewhere or
 * turns off the login would change who is billed, so two rules apply together:
 *
 *   1. The child gets an ALLOWLIST, never a copy. Only the operating-system and runtime
 *      variables the native CLI needs to find its own login reach it, plus names the
 *      operator approved on purpose (APAYEE_CLAUDE_PASSTHROUGH_ENV). Everything else -
 *      Apayee's own settings, unrelated secrets, a parent Claude Code session's variables -
 *      is simply not passed.
 *   2. Variables that would redirect authentication or billing are detected and stop the
 *      provider (fail closed). Names are reported, values never.
 *
 * The denied set follows Anthropic's environment-variable and authentication pages:
 * https://code.claude.com/docs/en/env-vars and https://code.claude.com/docs/en/authentication
 * (credential precedence, cloud-provider switches, base URLs, profiles and federation).
 */

/** OS and runtime names, upper-cased. Windows credentials live under USERPROFILE/APPDATA. */
const BASE_ALLOWLIST = new Set([
  // Windows
  'ALLUSERSPROFILE',
  'APPDATA',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'COMPUTERNAME',
  'COMSPEC',
  'DRIVERDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'PUBLIC',
  'SESSIONNAME',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
  // POSIX
  'HOME',
  'LANG',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TZ',
  'USER',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  // Both
  'PATH',
]);

/** Only for the interactive login, which opens a browser and draws in a terminal. */
const INTERACTIVE_ALLOWLIST = new Set([
  'BROWSER',
  'COLORTERM',
  'DISPLAY',
  'TERM',
  'WAYLAND_DISPLAY',
]);

/** Credentials, provider routing and switches that bypass the subscription login. */
const DENIED = [
  /^ANTHROPIC_/,
  /^AWS_BEARER_TOKEN_BEDROCK$/,
  /^CLAUDE_CODE_OAUTH_/,
  /^CLAUDE_CODE_SKIP_[A-Z_]*_AUTH$/,
  /^CLAUDE_CODE_CLIENT_/,
  /^CLAUDE_CODE_API_KEY/,
  /^CLAUDE_CODE_PROVIDER_/,
  // Bare mode never reads the subscription login; safe mode is applied by Apayee itself.
  /^CLAUDE_CODE_SIMPLE$/,
  /^CLAUDE_CODE_SAFE_MODE$/,
];

/** Cloud-provider switches: `0`, `false` and empty mean off. */
const PROVIDER_SWITCH = /^CLAUDE_CODE_USE_(?:BEDROCK|VERTEX|FOUNDRY|MANTLE|ANTHROPIC_AWS)$/;
const OFF = /^(?:|0|false|no|off)$/i;

/** A different configuration directory means a different login than the one Apayee checked. */
const CONFIG_DIR = 'CLAUDE_CONFIG_DIR';

const upper = (name) => String(name).toUpperCase();

/** Whether a name can never be passed to the CLI, even if an operator lists it. */
export function isDeniedEnvironmentName(name) {
  const key = upper(name);
  return DENIED.some((pattern) => pattern.test(key)) || PROVIDER_SWITCH.test(key);
}

/**
 * @param {object} env
 * @param {{approved?: string[]}} [options]  names the operator approved on purpose
 * @returns {string[]} the names (upper-case) that stop the provider, never their values
 */
export function findEnvironmentConflicts(env, { approved = [] } = {}) {
  const approvedKeys = new Set(approved.map(upper));
  const conflicts = [];

  for (const [name, value] of Object.entries(env)) {
    const key = upper(name);
    const text = String(value ?? '').trim();
    if (text === '') continue;

    if (PROVIDER_SWITCH.test(key)) {
      if (!OFF.test(text)) conflicts.push(key);
    } else if (DENIED.some((pattern) => pattern.test(key))) {
      conflicts.push(key);
    } else if (key === CONFIG_DIR && !approvedKeys.has(CONFIG_DIR)) {
      conflicts.push(key);
    }
  }

  return [...new Set(conflicts)];
}

/**
 * The environment the CLI is started with.
 *
 * @param {object} env
 * @param {object} [options]
 * @param {string[]} [options.approved]   names the operator approved (never a denied name)
 * @param {object} [options.extra]        fixed values Apayee itself sets
 * @param {boolean} [options.interactive] adds what a terminal login needs
 */
export function childEnvironment(env, { approved = [], extra = {}, interactive = false } = {}) {
  const allowed = new Set([
    ...BASE_ALLOWLIST,
    ...(interactive ? INTERACTIVE_ALLOWLIST : []),
    ...approved.map(upper),
  ]);

  const child = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const key = upper(name);

    if (key.startsWith('APAYEE_') || isDeniedEnvironmentName(key)) continue;
    if (allowed.has(key) || key.startsWith('LC_')) child[name] = value;
  }

  return { ...child, ...extra };
}
