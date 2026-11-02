import { compileClientSchema } from '../../validation/json-schema.js';
import { ClaudeProvider } from './claude.provider.js';
import { CliNotFoundError, resolveCli, runInteractive } from './cli.js';
import { childEnvironment, findEnvironmentConflicts } from './environment.js';
import { LOGIN_ARGS } from './invocation.js';
import { evaluateReadiness } from './readiness.js';

/**
 * What the `npm run claude:*` commands do, kept here so it can be tested.
 *
 * None of this touches a credential. Login is the official CLI's own interactive flow,
 * attached to the owner's terminal; status prints a short, whitelisted summary of what
 * `claude auth status` reports; the smoke test is the one command that sends a request to
 * the model, and only when asked to twice over.
 */

function locate({ settings, env, cli }) {
  if (cli) return cli;
  return resolveCli({ cliPath: settings.cliPath, env });
}

function refuseConflicts(settings, env, out) {
  const conflicts = findEnvironmentConflicts(env, { approved: settings.passthroughEnv });
  if (conflicts.length === 0) return false;
  out(`Stopped: these variables are set and would bypass the subscription login or change which login is used: ${conflicts.join(', ')}.`);
  out("Remove them from this terminal and from Apayee's .env, then run the command again.");
  return true;
}

/**
 * Starts the official `claude auth login`. Never passes `--console`, which selects API
 * billing, and never accepts extra arguments that could.
 *
 * @returns {Promise<number>} exit code
 */
export async function login({ settings, env, cli, out = console.log, interactive = runInteractive }) {
  if (refuseConflicts(settings, env, out)) return 1;

  let command;
  try {
    command = locate({ settings, env, cli });
  } catch (error) {
    if (!(error instanceof CliNotFoundError)) throw error;
    out(`Stopped: ${error.message}`);
    return 1;
  }

  out('Starting the official Claude Code login. Apayee never sees what you type.');
  out('Choose the Claude account (subscription) option. Do not choose Console or API billing.');
  out('Sign in as the same Windows/OS user that runs Apayee, on this machine.');
  out('');

  const code = await interactive({
    file: command.file,
    args: [...command.args, ...LOGIN_ARGS],
    env: childEnvironment(env, { approved: settings.passthroughEnv, interactive: true }),
  });

  out('');
  out(code === 0 ? 'The CLI reports the login finished.' : `The CLI exited with code ${code}.`);
  out('Next:');
  out('  1. Check which plan the account is on, in your Claude account settings. Apayee and');
  out('     the CLI cannot prove it: "claude auth status" does not name a plan.');
  out('  2. Only then set APAYEE_CLAUDE_SUBSCRIPTION_CONFIRMED=true in Apayee\'s .env. That is');
  out('     your own statement, not something Apayee verified.');
  out('  3. Run "npm run claude:status" to check readiness.');
  return code;
}

/** @returns {Promise<number>} 0 when ready, 2 when not */
export async function showStatus({ settings, env, cli, out = console.log }) {
  const readiness = await evaluateReadiness({ settings, env, cli });
  const details = readiness.details ?? {};
  const yesNo = (value) => (value ? 'yes' : 'no');
  const reported = (value, render) => (value === null || value === undefined ? 'not reported by the CLI' : render(value));

  out('Claude provider status');
  out(`  experimental enabled   : ${yesNo(settings.experimental)}`);
  out(`  plan attested by you   : ${yesNo(settings.subscriptionConfirmed)}   (your statement; not verified)`);
  out(`  CLI version            : ${details.cliVersion ?? 'not checked'}`);
  out(`  signed in              : ${reported(details.loggedIn, yesNo)}`);
  out(`  authentication method  : ${details.authMethod ?? 'not checked'}`);
  if (details.configDirectory) out(`  CLI config directory   : ${details.configDirectory}`);
  out('');
  out(`  READY                  : ${yesNo(readiness.ready)}  (${readiness.state})`);
  if (readiness.reason) out(`  ${readiness.reason}`);
  out('');
  out('Apayee cannot see which plan the account is on. Neither "claude auth status" nor /status');
  out('proves it. Check your plan in your Claude account settings.');
  return readiness.ready ? 0 : 2;
}

/**
 * Sends ONE tiny synthetic request through the provider. This is the only function in the
 * project that spends subscription usage, so it needs two explicit opt-ins: the command
 * itself and APAYEE_CLAUDE_SMOKE=1. It never loops and never retries.
 *
 * It prints sanitized evidence only: no prompt, no account identifier, no raw CLI output.
 *
 * @returns {Promise<number>}
 */
export async function smoke({ config, env, cli, out = console.log, clock = () => new Date() }) {
  if (env.APAYEE_CLAUDE_SMOKE !== '1') {
    out('This sends a REAL request to Claude and uses your Claude Pro subscription quota.');
    out('To run it anyway, set APAYEE_CLAUDE_SMOKE=1 for this command.');
    return 2;
  }

  const settings = config.claude;
  const readiness = await evaluateReadiness({ settings, env, cli });
  const evidence = [
    `timestamp         : ${clock().toISOString()}`,
    `CLI version       : ${readiness.details?.cliVersion ?? 'unknown'}`,
    `auth method       : ${readiness.details?.authMethod ?? 'unknown'}`,
    `readiness         : ${readiness.state}`,
    `API/provider env  : ${findEnvironmentConflicts(env, { approved: settings.passthroughEnv }).length === 0 ? 'none detected' : 'CONFLICT'}`,
  ];

  if (!readiness.ready) {
    out('Not sending anything: the provider is not ready.');
    out(readiness.reason ?? '');
    evidence.forEach((line) => out(`evidence ${line}`));
    return 2;
  }

  out('WARNING: sending one small synthetic request now. This uses Claude Pro subscription usage.');

  const provider = new ClaudeProvider({ config, env, cli });
  const schema = {
    type: 'object',
    required: ['answer'],
    additionalProperties: false,
    properties: { answer: { type: 'string' } },
  };
  const timeoutMs = 120_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();

  try {
    const { data, usage } = await provider.generate({
      system: 'You are a test of a private gateway. Answer exactly as asked.',
      prompt: 'Return the single word "pong" in the answer field.',
      schema,
      task: 'generic',
      signal: controller.signal,
      timeoutMs,
    });

    const verdict = compileClientSchema(schema)(data);
    evidence.push(
      'exit code         : 0',
      `duration          : ${Math.round(performance.now() - startedAt)} ms`,
      `schema valid      : ${verdict.valid ? 'yes' : 'NO'}`,
      `num_turns         : ${usage.num_turns ?? 'not reported'}`,
      `tokens in/out     : ${usage.input_tokens ?? 'n/a'} / ${usage.output_tokens ?? 'n/a'}`,
      'classification    : success'
    );
    out(`Reply        : ${JSON.stringify(data)}`);
    evidence.forEach((line) => out(`evidence ${line}`));
    return verdict.valid ? 0 : 1;
  } catch (error) {
    evidence.push(
      `duration          : ${Math.round(performance.now() - startedAt)} ms`,
      `num_turns         : ${error.numTurns ?? 'not reported'}`,
      `classification    : ${error.claudeKind ?? error.code ?? 'error'}`
    );
    out(`The request failed: ${error.code ?? 'error'} - ${error.message}`);
    if (error.claudeKind === 'no_structured_output') {
      out('Hint: "--tools \"\"" may also remove the StructuredOutput tool. That combination is not');
      out('documented; do not loosen the tool restrictions without reviewing what is enabled.');
    }
    if (error.diagnostic) out(`CLI said (for you only, not logged): ${error.diagnostic}`);
    evidence.forEach((line) => out(`evidence ${line}`));
    return 1;
  } finally {
    clearTimeout(timer);
  }
}
