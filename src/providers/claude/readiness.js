import { childEnvironment, findEnvironmentConflicts } from './environment.js';
import { CliNotFoundError, resolveCli, runCli } from './cli.js';
import {
  isSupportedVersion,
  MIN_CLI_VERSION,
  parseVersion,
  STATUS_ARGS,
  VERSION_ARGS,
} from './invocation.js';
import { withIsolatedDirectory } from './workdir.js';

/** `--version` and `auth status` are local reads; neither sends a model request. */
const PROBE_TIMEOUT_MS = 15_000;

const AUTH_METHOD = /^[a-z][a-z_.]{0,23}$/;

function notReady(state, reason, details = {}) {
  return { ready: false, state, reason, details };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether the provider may take work, in two stages. Conservative by design: it is ready
 * only when every check passes, and it never reads a credential file to compensate for a
 * check it cannot make.
 *
 * Stage 1, `checkStatic`, starts NO process. It is cheap enough to run on every health
 * poll, and a provider that fails it never costs a subprocess:
 *   1. the owner turned the experiment on
 *   2. the owner attested the account is the plan they mean
 *   3. nothing in the environment redirects the CLI away from the subscription login
 *   4. the official CLI can be found
 *
 * Stage 2, `probe`, starts the CLI twice (`--version`, `auth status`):
 *   5. it is new enough to be trusted (see MIN_CLI_VERSION)
 *   6. `claude auth status` reports a first-party claude.ai login
 *
 * Step 2 is an ATTESTATION. Nothing the CLI reports proves the plan: `loggedIn: true` and
 * `authMethod: claude.ai` hold for any claude.ai account, and `/status` is not documented
 * to name a plan. The owner has to check the plan in their Claude account settings.
 *
 * Neither stage sends a generation request.
 */

/** @returns {{ok: true, command: {file: string, args: string[]}} | {ok: false, result: object}} */
export function checkStatic({ settings, env, cli }) {
  if (!settings.experimental) {
    return {
      ok: false,
      result: notReady(
        'disabled',
        'The Claude provider is disabled. Set APAYEE_CLAUDE_EXPERIMENTAL=true to enable this experiment.'
      ),
    };
  }

  if (!settings.subscriptionConfirmed) {
    return {
      ok: false,
      result: notReady(
        'subscription_unconfirmed',
        'The plan has not been attested. Apayee cannot see which plan an account is on, and neither "claude auth status" nor /status proves it. Check your plan in your Claude account settings, then set APAYEE_CLAUDE_SUBSCRIPTION_CONFIRMED=true as your own statement.'
      ),
    };
  }

  const conflicts = findEnvironmentConflicts(env, { approved: settings.passthroughEnv });
  if (conflicts.length > 0) {
    return {
      ok: false,
      result: notReady(
        'api_environment_conflict',
        `These variables would bypass the subscription login or change which login is used, and must be removed from Apayee's environment: ${conflicts.join(', ')}.`
      ),
    };
  }

  try {
    return { ok: true, command: cli ?? resolveCli({ cliPath: settings.cliPath, env }) };
  } catch (error) {
    if (error instanceof CliNotFoundError) {
      return { ok: false, result: notReady(error.state, error.message) };
    }
    throw error;
  }
}

/**
 * Starts the CLI to learn its version and login state. Never throws.
 *
 * @returns {Promise<{ready: boolean, state: string, reason?: string, details: object}>}
 */
export async function probe({ settings, env, command }) {
  try {
    return await runProbe({ settings, env, command });
  } catch {
    return notReady('cli_not_runnable', 'The claude program could not be started.');
  }
}

/** Both stages, for callers that do not cache (the status command, the smoke test). */
export async function evaluateReadiness({ settings, env, cli }) {
  try {
    const stage = checkStatic({ settings, env, cli });
    return stage.ok
      ? await probe({ settings, env, command: stage.command })
      : stage.result;
  } catch {
    return notReady('status_unavailable', 'The Claude provider could not check its own state.');
  }
}

async function runProbe({ settings, env, command }) {
  const childEnv = childEnvironment(env, { approved: settings.passthroughEnv });
  const run = (args) =>
    withIsolatedDirectory((cwd) =>
      runCli({
        file: command.file,
        args: [...command.args, ...args],
        env: childEnv,
        cwd,
        timeoutMs: PROBE_TIMEOUT_MS,
      })
    );

  const versionRun = await run(VERSION_ARGS);
  const version = parseVersion(versionRun.stdout);
  if (versionRun.timedOut || !version) {
    return notReady('cli_unreadable', 'The claude program did not report a version.');
  }
  if (!isSupportedVersion(version)) {
    return notReady(
      'cli_too_old',
      `Claude Code ${version.join('.')} is older than the ${MIN_CLI_VERSION.join('.')} this provider requires: before 2.1.286 "claude auth status" could report an API key as claude.ai, and before 2.1.289 successful --json-schema runs could exit with an error. Run "claude update".`,
      { cliVersion: version.join('.') }
    );
  }

  return judge({ statusRun: await run(STATUS_ARGS), cliVersion: version.join('.') });
}

function judge({ statusRun, cliVersion }) {
  if (statusRun.timedOut) {
    return notReady('status_unavailable', '"claude auth status" did not answer in time.', {
      cliVersion,
    });
  }

  let status = null;
  try {
    status = JSON.parse(statusRun.stdout.trim());
  } catch {
    // Handled below.
  }
  if (!isRecord(status)) {
    return notReady(
      'status_unreadable',
      `"claude auth status" did not return readable JSON (exit code ${statusRun.code}). Run "npm run claude:status".`,
      { cliVersion }
    );
  }

  const authMethod = AUTH_METHOD.test(String(status.authMethod)) ? String(status.authMethod) : 'unknown';
  const details = {
    cliVersion,
    authMethod,
    // `loggedIn` is not in the documented list of status fields, so absent is not "no".
    loggedIn: typeof status.loggedIn === 'boolean' ? status.loggedIn : null,
    configDirectory: typeof status.configDirectory === 'string' ? status.configDirectory : null,
  };

  if (status.loggedIn === false || authMethod === 'none') {
    return notReady(
      'not_authenticated',
      'Claude Code is not signed in. Run "npm run claude:login" on this machine, as the same user that runs Apayee.',
      details
    );
  }

  if (authMethod !== 'claude.ai') {
    return notReady(
      'auth_mode_rejected',
      `Claude Code is signed in with "${authMethod}" authentication. Only a claude.ai subscription login is accepted; API keys, helpers, tokens and cloud providers are not.`,
      details
    );
  }

  return { ready: true, state: 'ready', details };
}
