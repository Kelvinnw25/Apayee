/**
 * Exactly how the Claude Code CLI is called, as data, so it can be read and tested
 * without starting anything.
 *
 * Every flag below is from the official CLI reference
 * (https://code.claude.com/docs/en/cli-reference). The sections explain why each one
 * is there; none is a shortcut. In particular `--bare` is not used: it skips the
 * subscription login and would not authenticate this provider at all, and
 * `--console` is never passed because it selects API billing.
 */

/**
 * Oldest CLI this provider will use, and why. Each point is from Anthropic's changelog
 * (https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md):
 *
 *   2.1.286  `claude auth status` stopped reporting a Console sign-in's stored API key as
 *            `claude.ai` and reports `api_key`. Before this, the authentication-method
 *            check below could not tell API billing from the subscription.
 *   2.1.289  Fixed headless `--json-schema` runs exiting non-zero with `is_error: true`
 *            on a successful result.
 *   2.1.299  Release notes already describe sessions "started with `--safe-mode`", so the
 *            flag exists. Its first release is not stated in the notes that were readable.
 *
 * 2.1.299 satisfies all three. Versions below it are reported as unsupported, not tried.
 * That the flags behave as described on a real CLI is still unproven until a live run.
 */
export const MIN_CLI_VERSION = [2, 1, 299];

/**
 * Documented in the environment-variable reference: the number of attempts Claude Code
 * allows when the model's reply fails validation against `--json-schema` with `-p`
 * ("Defaults to 5, a first attempt plus four retries"). Apayee sets it explicitly.
 */
export const STRUCTURED_OUTPUT_ATTEMPTS_VARIABLE = 'MAX_STRUCTURED_OUTPUT_RETRIES';

/**
 * A fixed instruction. The caller's own `system` text travels on stdin with the
 * prompt, not here, because command lines are length-limited and readable by other
 * local users.
 */
export const GATEWAY_SYSTEM_PROMPT =
  'You are a JSON generation function inside a private gateway. You have no tools and no files. ' +
  'Follow the instructions you are given exactly, and answer only by returning the structured output the schema requires.';

/** Windows allows about 32,000 characters on a command line; the schema is one argument. */
export const MAX_SCHEMA_ARGUMENT_CHARS = 16_000;

/**
 * A backstop, not the retry control: structured-output attempts are bounded by
 * MAX_STRUCTURED_OUTPUT_RETRIES. A normal run is one or two turns, so this only ends a run
 * that loops for another reason. Revisit with the `num_turns` a real run reports.
 */
const MAX_TURNS = '5';

export const LOGIN_ARGS = Object.freeze(['auth', 'login']);
export const STATUS_ARGS = Object.freeze(['auth', 'status']);
export const VERSION_ARGS = Object.freeze(['--version']);

/**
 * Arguments for one print-mode generation.
 *
 * - `-p` with `--output-format json`: one JSON result object on stdout.
 * - `--json-schema`: the client's own schema, so the CLI validates and retries.
 * - `--tools ""` and `--disallowedTools mcp__*`: no built-in tools and no MCP tools.
 * - `--strict-mcp-config` with no `--mcp-config`: no MCP server is loaded.
 * - `--safe-mode`: no hooks, skills, plugins, CLAUDE.md or auto memory, while the
 *   login keeps working (unlike `--bare`).
 * - `--permission-mode dontAsk`: nothing can wait for an answer nobody will give.
 * - `--no-session-persistence`: nothing is saved; no `--continue` or `--resume`.
 *
 * @param {{schema: object, model?: string|null}} options
 * @returns {string[]}
 */
export function buildPrintArgs({ schema, model }) {
  return [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(schema),
    '--system-prompt',
    GATEWAY_SYSTEM_PROMPT,
    '--tools',
    '',
    '--disallowedTools',
    'mcp__*',
    '--strict-mcp-config',
    '--safe-mode',
    '--disable-slash-commands',
    '--permission-mode',
    'dontAsk',
    '--no-session-persistence',
    '--max-turns',
    MAX_TURNS,
    ...(model ? ['--model', model] : []),
  ];
}

/** What goes to stdin: the caller's instruction and input, kept apart. */
export function buildPrintInput({ system, prompt }) {
  return `<instructions>\n${system}\n</instructions>\n\n<input>\n${prompt}\n</input>\n`;
}

/** @returns {number[]|null} [major, minor, patch] from `claude --version` output */
export function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function isSupportedVersion(version) {
  if (!version) return false;
  for (let index = 0; index < 3; index += 1) {
    if (version[index] !== MIN_CLI_VERSION[index]) return version[index] > MIN_CLI_VERSION[index];
  }
  return true;
}
