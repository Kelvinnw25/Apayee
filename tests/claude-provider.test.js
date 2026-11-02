import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { ConfigError, loadClaudeSettings, loadConfig } from '../src/config.js';
import { ApiError } from '../src/errors.js';
import { login, showStatus, smoke } from '../src/providers/claude/auth.js';
import { ClaudeProvider } from '../src/providers/claude/claude.provider.js';
import { CliNotFoundError, resolveCli, runCli } from '../src/providers/claude/cli.js';
import {
  childEnvironment,
  findEnvironmentConflicts,
  isDeniedEnvironmentName,
} from '../src/providers/claude/environment.js';
import {
  buildPrintArgs,
  buildPrintInput,
  isSupportedVersion,
  LOGIN_ARGS,
  MIN_CLI_VERSION,
  parseVersion,
  STATUS_ARGS,
} from '../src/providers/claude/invocation.js';
import { evaluateReadiness } from '../src/providers/claude/readiness.js';
import { availableProviders, createProvider } from '../src/providers/registry.js';
import { startServer } from '../src/server.js';
import {
  cleanEnvironment,
  cleanUpScratchAfterTests,
  claudeSettings,
  FAKE_CLI,
  fakeEnvironment,
  fakeProvider,
  isAlive,
  readCalls,
  readPid,
  scratch,
  setBehaviour,
} from './helpers/fake-claude.js';
import { requestBody, startTestServer, TEST_TOKEN, waitFor } from './helpers/harness.js';

cleanUpScratchAfterTests();

const PROMPT_MARKER = 'PROMPT-SECRET-MARKER';

async function health(server, headers) {
  const response = await fetch(`${server.baseUrl}/v1/health`, { headers });
  return response.json();
}

/** Behaviour for the fake, keeping the files the harness wants to inspect. */
const behave = (harness, behaviour) =>
  setBehaviour(harness.env, { log: harness.files.log, pidFile: harness.files.pidFile, ...behaviour });

const count = (harness, kind) => harness.calls().filter((call) => call.kind === kind).length;

describe('claude provider configuration', () => {
  test('everything defaults to off', () => {
    assert.deepEqual(loadClaudeSettings({}), {
      experimental: false,
      subscriptionConfirmed: false,
      cliPath: null,
      model: null,
      timeoutMs: 300_000,
      structuredOutputAttempts: 1,
      passthroughEnv: [],
    });
    assert.equal(loadConfig({}).provider, 'mock');
  });

  test('reads the documented settings', () => {
    const cliPath = join(scratch().dir, 'claude.exe');
    assert.deepEqual(
      loadClaudeSettings({
        APAYEE_CLAUDE_EXPERIMENTAL: 'true',
        APAYEE_CLAUDE_SUBSCRIPTION_CONFIRMED: 'true',
        APAYEE_CLAUDE_CLI_PATH: cliPath,
        APAYEE_CLAUDE_MODEL: 'sonnet',
        APAYEE_CLAUDE_TIMEOUT_MS: '90000',
        APAYEE_CLAUDE_STRUCTURED_OUTPUT_ATTEMPTS: '2',
        APAYEE_CLAUDE_PASSTHROUGH_ENV: 'HTTPS_PROXY, NODE_EXTRA_CA_CERTS,HTTPS_PROXY',
      }),
      {
        experimental: true,
        subscriptionConfirmed: true,
        cliPath,
        model: 'sonnet',
        timeoutMs: 90_000,
        structuredOutputAttempts: 2,
        passthroughEnv: ['HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS'],
      }
    );
  });

  test('invalid values stop startup instead of falling back', () => {
    for (const env of [
      { APAYEE_CLAUDE_EXPERIMENTAL: 'yes' },
      { APAYEE_CLAUDE_SUBSCRIPTION_CONFIRMED: '1' },
      { APAYEE_CLAUDE_CLI_PATH: 'claude' },
      { APAYEE_CLAUDE_CLI_PATH: '..\\claude.exe' },
      { APAYEE_CLAUDE_MODEL: 'sonnet; rm -rf /' },
      { APAYEE_CLAUDE_MODEL: '--dangerously-skip-permissions' },
      { APAYEE_CLAUDE_TIMEOUT_MS: '0' },
      { APAYEE_CLAUDE_TIMEOUT_MS: 'soon' },
      { APAYEE_CLAUDE_STRUCTURED_OUTPUT_ATTEMPTS: '0' },
      { APAYEE_CLAUDE_STRUCTURED_OUTPUT_ATTEMPTS: '6' },
      { APAYEE_CLAUDE_PASSTHROUGH_ENV: 'bad name!' },
    ]) {
      assert.throws(() => loadClaudeSettings(env), ConfigError, JSON.stringify(env));
    }
  });

  test('the operator can never approve a credential, a routing override or an Apayee setting', () => {
    for (const name of [
      'ANTHROPIC_API_KEY',
      'anthropic_base_url',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_SIMPLE',
      'AWS_BEARER_TOKEN_BEDROCK',
      'APAYEE_AUTH_TOKEN',
    ]) {
      assert.throws(
        () => loadClaudeSettings({ APAYEE_CLAUDE_PASSTHROUGH_ENV: `HTTPS_PROXY,${name}` }),
        (error) => error instanceof ConfigError && !/HTTPS_PROXY/.test(error.message),
        name
      );
    }
    // A configuration directory can be approved on purpose, because it is not a credential.
    assert.deepEqual(
      loadClaudeSettings({ APAYEE_CLAUDE_PASSTHROUGH_ENV: 'CLAUDE_CONFIG_DIR' }).passthroughEnv,
      ['CLAUDE_CONFIG_DIR']
    );
  });

  test('the claude provider needs the token and refuses to listen beyond this machine', () => {
    assert.throws(
      () => loadConfig({ APAYEE_PROVIDER: 'claude' }),
      (error) => error instanceof ConfigError && /requires APAYEE_AUTH_TOKEN/.test(error.message)
    );
    assert.throws(
      () =>
        loadConfig({
          APAYEE_PROVIDER: 'claude',
          APAYEE_AUTH_TOKEN: TEST_TOKEN,
          APAYEE_HOST: '10.0.0.5',
          APAYEE_ALLOW_REMOTE: 'true',
        }),
      (error) => error instanceof ConfigError && /owner-only/.test(error.message)
    );
    assert.equal(
      loadConfig({ APAYEE_PROVIDER: 'claude', APAYEE_AUTH_TOKEN: TEST_TOKEN }).provider,
      'claude'
    );
  });

  test('is registered by name and needs the service configuration', () => {
    assert.deepEqual(availableProviders(), ['mock', 'claude']);

    const provider = createProvider('claude', undefined, { config: loadConfig({}), env: {} });
    assert.equal(provider.name, 'claude');
    assert.throws(() => createProvider('claude'), ConfigError);
  });
});

describe('how the CLI is called', () => {
  const schema = { type: 'object', properties: { answer: { type: 'string' } } };

  test('print mode with structured output, no tools, no session and no shell', () => {
    const args = buildPrintArgs({ schema });
    const at = (flag) => args.indexOf(flag);

    assert.equal(args[0], '-p');
    assert.equal(args[at('--output-format') + 1], 'json');
    assert.equal(args[at('--json-schema') + 1], JSON.stringify(schema));
    assert.equal(args[at('--tools') + 1], '', 'all built-in tools are switched off');
    assert.equal(args[at('--disallowedTools') + 1], 'mcp__*');
    assert.ok(args.includes('--strict-mcp-config'));
    assert.ok(args.includes('--safe-mode'));
    assert.equal(args[at('--permission-mode') + 1], 'dontAsk');
    assert.ok(args.includes('--no-session-persistence'));
    assert.ok(args.includes('--max-turns'));
  });

  test('never selects API billing, bare mode, another session or looser permissions', () => {
    const args = buildPrintArgs({ schema, model: 'sonnet' }).concat(LOGIN_ARGS, STATUS_ARGS);
    for (const forbidden of [
      '--bare',
      '--console',
      '--continue',
      '-c',
      '--resume',
      '-r',
      '--dangerously-skip-permissions',
      '--allowedTools',
      '--mcp-config',
      '--add-dir',
      '--settings',
      '--betas',
    ]) {
      assert.ok(!args.includes(forbidden), forbidden);
    }
  });

  test('the model is passed only when one is configured', () => {
    assert.ok(!buildPrintArgs({ schema }).includes('--model'));
    const args = buildPrintArgs({ schema, model: 'opus[1m]' });
    assert.equal(args[args.indexOf('--model') + 1], 'opus[1m]');
  });

  test('login and status use the official commands and nothing else', () => {
    assert.deepEqual([...LOGIN_ARGS], ['auth', 'login']);
    assert.deepEqual([...STATUS_ARGS], ['auth', 'status']);
  });

  test('request content goes on stdin, intact, and never on the command line', () => {
    const system = 'rules `calc.exe` $(touch x)';
    const prompt = `${PROMPT_MARKER} "; rm -rf / & del /q *`;
    const input = buildPrintInput({ system, prompt });
    const args = buildPrintArgs({ schema }).join('\n');

    assert.ok(input.includes(system));
    assert.ok(input.includes(prompt));
    assert.ok(!args.includes(PROMPT_MARKER));
    assert.ok(!args.includes('calc.exe'));
  });

  test('versions are compared numerically, against a floor with documented reasons', () => {
    assert.deepEqual(MIN_CLI_VERSION, [2, 1, 299]);
    assert.deepEqual(parseVersion('2.1.314 (Claude Code)'), [2, 1, 314]);
    assert.equal(parseVersion('no version here'), null);
    assert.equal(isSupportedVersion([2, 1, 299]), true);
    assert.equal(isSupportedVersion([2, 1, 298]), false, 'before safe mode is described in the notes');
    assert.equal(isSupportedVersion([2, 1, 288]), false, 'before --json-schema success exits cleanly');
    assert.equal(isSupportedVersion([2, 1, 285]), false, 'before auth status reports api_key');
    assert.equal(isSupportedVersion([2, 2, 0]), true);
    assert.equal(isSupportedVersion([1, 99, 999]), false);
    assert.equal(isSupportedVersion(null), false);
  });
});

describe('environment: an allowlist in, and a stop for anything that redirects the login', () => {
  /** Every variable the documentation lists that changes authentication, routing or billing. */
  const documented = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_CUSTOM_HEADERS',
    'ANTHROPIC_PROFILE',
    'ANTHROPIC_FEDERATION_RULE_ID',
    'ANTHROPIC_ORGANIZATION_ID',
    'ANTHROPIC_WORKSPACE_ID',
    'ANTHROPIC_IDENTITY_TOKEN_FILE',
    'ANTHROPIC_BEDROCK_BASE_URL',
    'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
    'ANTHROPIC_AWS_API_KEY',
    'ANTHROPIC_AWS_BASE_URL',
    'ANTHROPIC_AWS_WORKSPACE_ID',
    'ANTHROPIC_VERTEX_BASE_URL',
    'ANTHROPIC_VERTEX_PROJECT_ID',
    'ANTHROPIC_FOUNDRY_API_KEY',
    'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
    'ANTHROPIC_FOUNDRY_BASE_URL',
    'ANTHROPIC_FOUNDRY_RESOURCE',
    'ANTHROPIC_MODEL',
    'AWS_BEARER_TOKEN_BEDROCK',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
    'CLAUDE_CODE_OAUTH_SCOPES',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_MANTLE',
    'CLAUDE_CODE_USE_ANTHROPIC_AWS',
    'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
    'CLAUDE_CODE_SKIP_VERTEX_AUTH',
    'CLAUDE_CODE_SKIP_MANTLE_AUTH',
    'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH',
    'CLAUDE_CODE_CLIENT_CERT',
    'CLAUDE_CODE_CLIENT_KEY',
    'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
    'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
    'CLAUDE_CODE_SIMPLE',
    'CLAUDE_CODE_SAFE_MODE',
    'CLAUDE_CONFIG_DIR',
  ];

  test('every documented authentication, routing and billing variable stops the provider', () => {
    for (const name of documented) {
      assert.deepEqual(findEnvironmentConflicts({ [name]: '1' }), [name], name);
      assert.deepEqual(findEnvironmentConflicts({ [name.toLowerCase()]: '1' }), [name], name);
    }
  });

  test('names are reported, never values', () => {
    const conflicts = findEnvironmentConflicts({
      ANTHROPIC_API_KEY: 'sk-ant-value-that-must-not-appear',
      ANTHROPIC_BASE_URL: 'https://proxy.example',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-value-that-must-not-appear',
    });
    assert.deepEqual(conflicts.sort(), [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ]);
    assert.doesNotMatch(JSON.stringify(conflicts), /must-not-appear|proxy\.example/);
  });

  test('empty values and switched-off provider flags are not conflicts', () => {
    assert.deepEqual(
      findEnvironmentConflicts({
        ANTHROPIC_API_KEY: '   ',
        CLAUDE_CODE_USE_BEDROCK: '0',
        CLAUDE_CODE_USE_VERTEX: 'false',
        PATH: 'x',
      }),
      []
    );
  });

  test('a parent Claude Code session leaves variables that are neither passed on nor fatal', () => {
    const inherited = {
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'vscode',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_CODE_MESSAGING_TOKEN: 'session-token-must-not-pass',
      PATH: 'p',
    };
    assert.deepEqual(findEnvironmentConflicts(inherited), []);
    assert.deepEqual(childEnvironment(inherited), { PATH: 'p' });
  });

  test('a configuration directory is a conflict until the operator approves it', () => {
    assert.deepEqual(findEnvironmentConflicts({ CLAUDE_CONFIG_DIR: 'D:\\claude' }), ['CLAUDE_CONFIG_DIR']);
    assert.deepEqual(
      findEnvironmentConflicts({ CLAUDE_CONFIG_DIR: 'D:\\claude' }, { approved: ['CLAUDE_CONFIG_DIR'] }),
      []
    );
    assert.deepEqual(
      childEnvironment({ CLAUDE_CONFIG_DIR: 'D:\\claude' }, { approved: ['CLAUDE_CONFIG_DIR'] }),
      { CLAUDE_CONFIG_DIR: 'D:\\claude' }
    );
    assert.deepEqual(childEnvironment({ CLAUDE_CONFIG_DIR: 'D:\\claude' }), {});
  });

  test('the child gets only the operating-system variables it needs', () => {
    const child = childEnvironment({
      PATH: 'p',
      Path: 'p2',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\me',
      APPDATA: 'a',
      LOCALAPPDATA: 'l',
      TEMP: 't',
      LC_ALL: 'C',
      HTTPS_PROXY: 'http://user:secret@proxy',
      GEMINI_API_KEY: 'g',
      NODE_OPTIONS: '--require x',
      SECRET_THING: 's',
      APAYEE_AUTH_TOKEN: TEST_TOKEN,
      apayee_port: '1',
      UNDEFINED_ONE: undefined,
    });
    assert.deepEqual(Object.keys(child).sort(), [
      'APPDATA',
      'LC_ALL',
      'LOCALAPPDATA',
      'PATH',
      'Path',
      'SystemRoot',
      'TEMP',
      'USERPROFILE',
    ]);
  });

  test('approved names are added, a denied name never is, and fixed values are Apayee\'s own', () => {
    const child = childEnvironment(
      { PATH: 'p', HTTPS_PROXY: 'http://proxy', ANTHROPIC_API_KEY: 'sk', CLAUDE_CODE_OAUTH_TOKEN: 't' },
      { approved: ['HTTPS_PROXY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'], extra: { FIXED: '1' } }
    );
    assert.deepEqual(child, { PATH: 'p', HTTPS_PROXY: 'http://proxy', FIXED: '1' });
    assert.equal(isDeniedEnvironmentName('claude_code_oauth_token'), true);
    assert.equal(isDeniedEnvironmentName('HTTPS_PROXY'), false);
  });

  test('the interactive login also gets what a terminal and a browser launch need', () => {
    const env = { PATH: 'p', TERM: 'xterm', DISPLAY: ':0', ANTHROPIC_API_KEY: 'x' };
    assert.deepEqual(childEnvironment(env), { PATH: 'p' });
    assert.deepEqual(childEnvironment(env, { interactive: true }), {
      PATH: 'p',
      TERM: 'xterm',
      DISPLAY: ':0',
    });
  });
});

describe('finding the official program', () => {
  test('on Windows a script launcher is refused rather than started through a shell', () => {
    const { dir } = scratch();
    writeFileSync(join(dir, 'claude.cmd'), '@echo off');

    assert.throws(
      () => resolveCli({ cliPath: join(dir, 'claude.cmd'), env: {}, platform: 'win32' }),
      (error) => error instanceof CliNotFoundError && error.state === 'cli_unsupported_launcher'
    );
    assert.throws(
      () => resolveCli({ env: { Path: dir }, platform: 'win32' }),
      (error) => error instanceof CliNotFoundError && error.state === 'cli_unsupported_launcher'
    );
  });

  test('on Windows claude.exe is found on PATH or by explicit path', () => {
    const { dir } = scratch();
    writeFileSync(join(dir, 'claude.exe'), 'MZ');

    assert.deepEqual(resolveCli({ env: { Path: dir }, platform: 'win32' }), {
      file: join(dir, 'claude.exe'),
      args: [],
    });
    assert.equal(
      resolveCli({ cliPath: join(dir, 'claude.exe'), env: {}, platform: 'win32' }).file,
      join(dir, 'claude.exe')
    );
  });

  test('a missing program is reported, with how to fix it', () => {
    const { dir } = scratch();
    assert.throws(
      () => resolveCli({ env: { PATH: dir }, platform: 'linux' }),
      (error) => error instanceof CliNotFoundError && error.state === 'cli_not_found'
    );
    assert.throws(
      () => resolveCli({ cliPath: join(dir, 'missing.exe'), env: {} }),
      (error) => error instanceof CliNotFoundError && /APAYEE_CLAUDE_CLI_PATH/.test(error.message)
    );
  });

  test(
    'elsewhere only an executable file counts',
    { skip: process.platform === 'win32' },
    () => {
      const { dir } = scratch();
      const program = join(dir, 'claude');
      writeFileSync(program, '#!/bin/sh\n');

      chmodSync(program, 0o644);
      assert.throws(() => resolveCli({ env: { PATH: dir }, platform: 'linux' }), CliNotFoundError);

      chmodSync(program, 0o755);
      assert.equal(resolveCli({ env: { PATH: dir }, platform: 'linux' }).file, program);
    }
  );
});

describe('readiness: static prerequisites first, then at most two probe processes', () => {
  const evaluate = (behaviour, settings = {}, extraEnv = {}) => {
    const files = scratch();
    const env = fakeEnvironment({ log: files.log, ...behaviour }, extraEnv);
    return evaluateReadiness({ settings: claudeSettings(settings), env, cli: FAKE_CLI }).then(
      (readiness) => ({ readiness, calls: readCalls(files.log) })
    );
  };

  test('disabled by default, and nothing is started', async () => {
    const { readiness, calls } = await evaluate({}, { experimental: false });
    assert.equal(readiness.ready, false);
    assert.equal(readiness.state, 'disabled');
    assert.deepEqual(calls, []);
  });

  test('an unconfirmed plan stops BEFORE any process starts, and says it is an attestation', async () => {
    const { readiness, calls } = await evaluate({}, { subscriptionConfirmed: false });
    assert.equal(readiness.ready, false);
    assert.equal(readiness.state, 'subscription_unconfirmed');
    assert.deepEqual(calls, [], 'no CLI process was started');
    assert.match(readiness.reason, /account settings/);
    assert.match(readiness.reason, /APAYEE_CLAUDE_SUBSCRIPTION_CONFIRMED=true/);
    assert.match(readiness.reason, /neither "claude auth status" nor \/status proves it/);
    assert.doesNotMatch(readiness.reason, /names your|shows your|confirm it/i);
  });

  test('an API key, provider override or config directory stops it by name, before any process', async () => {
    for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CONFIG_DIR']) {
      const { readiness, calls } = await evaluate({}, {}, { [name]: 'sk-ant-never-shown' });
      assert.equal(readiness.ready, false, name);
      assert.equal(readiness.state, 'api_environment_conflict', name);
      assert.match(readiness.reason, new RegExp(name));
      assert.doesNotMatch(JSON.stringify(readiness), /never-shown/);
      assert.deepEqual(calls, [], name);
    }
  });

  test('a program that cannot be found is not ready', async () => {
    const readiness = await evaluateReadiness({
      settings: claudeSettings({ cliPath: join(scratch().dir, 'no-such-claude.exe') }),
      env: cleanEnvironment(),
    });
    assert.equal(readiness.state, 'cli_not_found');
  });

  test('a CLI below the documented floor is not tried, and the reason names the evidence', async () => {
    const { readiness } = await evaluate({ version: '2.1.298' });
    assert.equal(readiness.state, 'cli_too_old');
    assert.match(readiness.reason, /2\.1\.299/);
    assert.match(readiness.reason, /2\.1\.286/);
    assert.match(readiness.reason, /2\.1\.289/);
    assert.equal((await evaluate({ version: '2.1.299' })).readiness.ready, true);
  });

  test('signed out is not ready and says how to sign in', async () => {
    const { readiness } = await evaluate({ auth: { loggedIn: false, authMethod: 'none' } });
    assert.equal(readiness.state, 'not_authenticated');
    assert.match(readiness.reason, /npm run claude:login/);
  });

  test('API-key, helper, token and cloud logins are rejected', async () => {
    for (const authMethod of ['api_key', 'api_key_helper', 'oauth_token', 'third_party']) {
      const { readiness } = await evaluate({ auth: { loggedIn: true, authMethod } });
      assert.equal(readiness.state, 'auth_mode_rejected', authMethod);
      assert.equal(readiness.ready, false);
    }
  });

  test('ready only when every check passes, using only --version and auth status', async () => {
    const { readiness, calls } = await evaluate({});
    assert.equal(readiness.ready, true);
    assert.equal(readiness.state, 'ready');
    assert.equal(readiness.details.authMethod, 'claude.ai');
    assert.deepEqual(
      calls.map((call) => call.kind),
      ['version', 'status']
    );
  });

  test('a missing loggedIn field is reported as not reported, never as "no"', async () => {
    const { readiness } = await evaluate({ auth: { authMethod: 'claude.ai' } });
    assert.equal(readiness.ready, true);
    assert.equal(readiness.details.loggedIn, null);

    const lines = [];
    await showStatus({
      settings: claudeSettings(),
      env: fakeEnvironment({ auth: { authMethod: 'claude.ai' } }),
      cli: FAKE_CLI,
      out: (line) => lines.push(line),
    });
    const text = lines.join('\n');
    assert.match(text, /signed in\s+: not reported by the CLI/);
    assert.match(text, /READY\s+: yes/);
    assert.doesNotMatch(text, /signed in\s+: no\s*$/m);
  });

  test('unreadable status output is not ready', async () => {
    const { readiness } = await evaluate({ auth: 'garbage' });
    assert.equal(readiness.state, 'status_unreadable');
  });
});

describe('health, as QATOOL reads it', () => {
  test('the mock provider is unchanged', async () => {
    const server = await startTestServer();
    try {
      const body = await health(server);
      assert.equal(body.provider, 'mock');
      assert.deepEqual(body.provider_status, { ready: true, state: 'ready' });
    } finally {
      await server.close();
    }
  });

  test('the exact name "claude" appears only when the provider is ready', async () => {
    const ready = fakeProvider();
    const unconfirmed = fakeProvider({ settings: { subscriptionConfirmed: false } });
    const disabled = fakeProvider({ settings: { experimental: false } });
    const signedOut = fakeProvider({ behaviour: { auth: { loggedIn: false, authMethod: 'none' } } });

    const results = {};
    for (const [name, harness] of Object.entries({ ready, unconfirmed, disabled, signedOut })) {
      const server = await startTestServer({ provider: harness.provider });
      try {
        results[name] = await health(server);
      } finally {
        await server.close();
      }
    }

    assert.equal(results.ready.provider, 'claude');
    assert.equal(results.ready.provider_status.ready, true);
    assert.equal(results.ready.provider_status.cli_version, '2.1.314');

    for (const name of ['unconfirmed', 'disabled', 'signedOut']) {
      assert.notEqual(results[name].provider, 'claude', name);
      assert.equal(results[name].provider, 'claude_not_ready', name);
      assert.equal(results[name].provider_status.ready, false, name);
      assert.equal(typeof results[name].provider_status.reason, 'string', name);
    }
    assert.equal(results.unconfirmed.provider_status.state, 'subscription_unconfirmed');
    assert.equal(results.disabled.provider_status.state, 'disabled');
    assert.equal(results.signedOut.provider_status.state, 'not_authenticated');
  });

  test('health shows no path, account detail or credential', async () => {
    const harness = fakeProvider({
      behaviour: {
        auth: {
          loggedIn: true,
          authMethod: 'claude.ai',
          email: 'owner@example.com',
          accessToken: 'tok-SECRET-VALUE',
          configDirectory: 'C:\\Users\\owner\\.claude',
        },
      },
    });
    const server = await startTestServer({ provider: harness.provider });
    try {
      const text = JSON.stringify(await health(server));
      assert.doesNotMatch(text, /owner@example|SECRET|\.claude|Users|[A-Za-z]:\\\\/);
    } finally {
      await server.close();
    }
  });
});

describe('health polling does not start a process storm and never generates', () => {
  test('static not-ready states never start the CLI, however often health is polled', async () => {
    const harnesses = {
      disabled: fakeProvider({ settings: { experimental: false } }),
      unconfirmed: fakeProvider({ settings: { subscriptionConfirmed: false } }),
      conflict: fakeProvider({ env: { ANTHROPIC_API_KEY: 'sk-ant-never-shown' } }),
    };
    for (const [name, harness] of Object.entries(harnesses)) {
      const server = await startTestServer({ provider: harness.provider });
      try {
        for (let index = 0; index < 20; index += 1) await health(server);
        await Promise.all(Array.from({ length: 20 }, () => health(server)));
        assert.deepEqual(harness.calls(), [], name);
      } finally {
        await server.close();
      }
    }
  });

  test('a signed-out CLI is probed once for a burst of polls, then with growing backoff', async () => {
    let now = 1_000_000;
    const harness = fakeProvider({
      behaviour: { auth: { loggedIn: false, authMethod: 'none' } },
      now: () => now,
    });
    const server = await startTestServer({ provider: harness.provider });
    try {
      const poll = () => health(server);
      const probes = () => ({ version: count(harness, 'version'), status: count(harness, 'status') });

      await Promise.all(Array.from({ length: 25 }, poll));
      for (let index = 0; index < 25; index += 1) await poll();
      assert.deepEqual(probes(), { version: 1, status: 1 }, '50 polls, one probe');

      now += 14_000;
      await poll();
      assert.equal(probes().status, 1, 'still inside the first 15 s');

      now += 2_000;
      await poll();
      assert.equal(probes().status, 2, 'probed again after 15 s');

      now += 29_000;
      await poll();
      assert.equal(probes().status, 2, 'the second wait is 30 s');

      now += 2_000;
      await poll();
      assert.equal(probes().status, 3);

      now += 59_000;
      await poll();
      assert.equal(probes().status, 3, 'the wait stops growing at 60 s');
      now += 2_000;
      await poll();
      assert.equal(probes().status, 4);

      assert.equal(harness.prints().length, 0, 'health never sends a generation request');
    } finally {
      await server.close();
    }
  });

  test('signing in is noticed once the backoff ends, and the answer is then cached for a minute', async () => {
    let now = 1_000_000;
    const harness = fakeProvider({
      behaviour: { auth: { loggedIn: false, authMethod: 'none' } },
      now: () => now,
    });
    const server = await startTestServer({ provider: harness.provider });
    try {
      assert.equal((await health(server)).provider, 'claude_not_ready');

      behave(harness, { auth: { loggedIn: true, authMethod: 'claude.ai' } });
      now += 16_000;
      assert.equal((await health(server)).provider, 'claude');
      assert.equal(count(harness, 'status'), 2);

      now += 59_000;
      await health(server);
      assert.equal(count(harness, 'status'), 2, 'a ready answer is trusted for 60 s');
      now += 2_000;
      await health(server);
      assert.equal(count(harness, 'status'), 3);

      assert.equal(harness.prints().length, 0);
    } finally {
      await server.close();
    }
  });
});

describe('generating through the service', () => {
  test('returns the structured answer, with the CLI called safely', async () => {
    const harness = fakeProvider({
      behaviour: { output: { answer: 'hello' } },
      env: { APAYEE_AUTH_TOKEN: TEST_TOKEN },
    });
    const server = await startTestServer({ provider: harness.provider });
    try {
      const response = await server.post(
        requestBody({ system: 'be brief', prompt: `${PROMPT_MARKER} \`calc.exe\`; $(touch x) & del *` })
      );

      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.provider, 'claude');
      assert.deepEqual(response.body.result, { answer: 'hello' });
      assert.deepEqual(response.body.metadata.usage, {
        input_tokens: 11,
        output_tokens: 7,
        num_turns: 2,
      });

      const [call] = harness.prints();
      assert.equal(harness.prints().length, 1);
      assert.ok(call.args.includes('--safe-mode'));
      assert.ok(call.args.includes('--no-session-persistence'));
      assert.ok(call.args.includes('--json-schema'));
      assert.doesNotMatch(call.args.join('\n'), new RegExp(PROMPT_MARKER));

      assert.match(call.stdin, /be brief/);
      assert.ok(call.stdin.includes(`${PROMPT_MARKER} \`calc.exe\`; $(touch x) & del *`));

      assert.equal(call.hasApayeeToken, false, "Apayee's own settings are not passed on");
      assert.ok(!existsSync(call.cwd), 'the empty working directory is removed afterwards');
    } finally {
      await server.close();
    }
  });

  test('reports num_turns, because one request is not one model turn', async () => {
    const harness = fakeProvider({
      behaviour: { run: 'custom', fields: { structured_output: { answer: 'x' }, num_turns: 3 }, exit: 0 },
    });
    const server = await startTestServer({ provider: harness.provider });
    try {
      const response = await server.post(requestBody());
      assert.equal(response.status, 200);
      assert.equal(response.body.metadata.usage.num_turns, 3);

      const finished = harness.events.find((event) => event.event === 'claude_cli_finished');
      assert.equal(finished.level, 'info');
      assert.equal(finished.num_turns, 3);
      assert.ok(Number.isInteger(finished.duration_ms));
      assert.doesNotMatch(JSON.stringify(finished), /answer/, 'counts only, never content');
    } finally {
      await server.close();
    }
  });

  test('the CLI is given one structured-output attempt unless the operator allows more', async () => {
    for (const [settings, expected] of [
      [{}, '1'],
      [{ structuredOutputAttempts: 3 }, '3'],
    ]) {
      const harness = fakeProvider({ settings });
      const server = await startTestServer({ provider: harness.provider });
      try {
        await server.post(requestBody());
        assert.equal(harness.prints()[0].retries, expected);
      } finally {
        await server.close();
      }
    }
  });

  test('the CLI inherits only the allowlist and what the operator approved', async () => {
    const harness = fakeProvider({
      settings: { passthroughEnv: ['FAKE_CLAUDE', 'HTTPS_PROXY'] },
      env: {
        APAYEE_AUTH_TOKEN: TEST_TOKEN,
        GEMINI_API_KEY: 'g-never-passed',
        NODE_OPTIONS: '--no-warnings',
        SECRET_THING: 'never-passed',
        CLAUDECODE: '1',
        CLAUDE_CODE_MESSAGING_TOKEN: 'session-token-never-passed',
        HTTPS_PROXY: 'http://proxy.invalid:3128',
      },
    });
    const server = await startTestServer({ provider: harness.provider });
    try {
      assert.equal((await server.post(requestBody())).status, 200);
      const { envNames } = harness.prints()[0];

      for (const wanted of ['FAKE_CLAUDE', 'HTTPS_PROXY', 'MAX_STRUCTURED_OUTPUT_RETRIES', 'PATH']) {
        assert.ok(envNames.includes(wanted), `${wanted} reaches the CLI`);
      }
      for (const unwanted of [
        'APAYEE_AUTH_TOKEN',
        'GEMINI_API_KEY',
        'NODE_OPTIONS',
        'SECRET_THING',
        'CLAUDECODE',
        'CLAUDE_CODE_MESSAGING_TOKEN',
      ]) {
        assert.ok(!envNames.includes(unwanted), `${unwanted} does not reach the CLI`);
      }
    } finally {
      await server.close();
    }
  });

  test('accepts the CLI printing every message of a run as an array', async () => {
    const harness = fakeProvider({ behaviour: { run: 'array' } });
    const server = await startTestServer({ provider: harness.provider });
    try {
      const response = await server.post(requestBody());
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.result, { answer: 'from-fake-claude' });
    } finally {
      await server.close();
    }
  });

  test('passes the configured model on', async () => {
    const harness = fakeProvider({ settings: { model: 'sonnet' } });
    const server = await startTestServer({ provider: harness.provider });
    try {
      await server.post(requestBody());
      const [call] = harness.prints();
      assert.equal(call.args[call.args.indexOf('--model') + 1], 'sonnet');
    } finally {
      await server.close();
    }
  });
});

describe('when the provider is not ready, nothing is generated and the error says it is not retryable', () => {
  const unavailable = async (harness) => {
    const server = await startTestServer({ provider: harness.provider });
    try {
      const response = await server.post(requestBody({ request_id: 'not-ready' }));
      assert.equal(response.status, 503, JSON.stringify(response.body));
      assert.equal(response.body.error.code, 'PROVIDER_NOT_READY');
      assert.equal(response.body.error.retryable, false);
      assert.match(response.body.error.message, /not ready/);
      assert.doesNotMatch(response.body.error.message, /overload|temporar|usually clears/i);
      assert.equal(response.body.result, undefined);
      assert.equal(harness.prints().length, 0, 'no generation request was sent');
      return response;
    } finally {
      await server.close();
    }
  };

  test('disabled', async () => {
    const harness = fakeProvider({ settings: { experimental: false } });
    await unavailable(harness);
    assert.deepEqual(harness.calls(), [], 'the CLI is not even started');
  });

  test('signed out', async () => {
    await unavailable(fakeProvider({ behaviour: { auth: { loggedIn: false, authMethod: 'none' } } }));
  });

  test('plan not attested: nothing at all is started', async () => {
    const harness = fakeProvider({ settings: { subscriptionConfirmed: false } });
    await unavailable(harness);
    assert.deepEqual(harness.calls(), []);
  });

  test('an API key appearing in the environment later stops the very next request', async () => {
    const harness = fakeProvider();
    const server = await startTestServer({ provider: harness.provider });
    try {
      assert.equal((await server.post(requestBody({ request_id: 'before' }))).status, 200);

      harness.env.ANTHROPIC_API_KEY = 'sk-ant-never-shown';
      const response = await server.post(requestBody({ request_id: 'after' }));

      assert.equal(response.status, 503);
      assert.equal(response.body.error.code, 'PROVIDER_NOT_READY');
      assert.doesNotMatch(JSON.stringify(response.body), /never-shown/);
      assert.equal(harness.prints().length, 1);
    } finally {
      await server.close();
    }
  });

  test('through the real registry the service never falls back to the mock', async () => {
    const started = await startServer({
      env: {
        APAYEE_PROVIDER: 'claude',
        APAYEE_AUTH_TOKEN: TEST_TOKEN,
        APAYEE_PORT: '0',
        APAYEE_LOG_LEVEL: 'silent',
      },
      signals: new EventEmitter(),
    });
    try {
      const headers = { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' };

      const body = await (await fetch(`${started.address}/v1/health`, { headers })).json();
      assert.equal(body.provider, 'claude_not_ready');
      assert.equal(body.provider_status.state, 'disabled');

      const response = await fetch(`${started.address}/v1/generate`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody()),
      });
      const failure = await response.json();
      assert.equal(response.status, 503);
      assert.equal(failure.error.code, 'PROVIDER_NOT_READY');
      assert.equal(failure.result, undefined);
      assert.notEqual(failure.provider, 'mock');
    } finally {
      await started.shutdown();
    }
  });
});

describe('failures are typed, safe and never retried', () => {
  async function failure(behaviour, { schema } = {}) {
    const harness = fakeProvider({ behaviour });
    const server = await startTestServer({ provider: harness.provider });
    try {
      const response = await server.post(
        requestBody({ prompt: `${PROMPT_MARKER} please`, ...(schema ? { schema } : {}) })
      );
      assert.equal(
        harness.prints().length,
        schema ? 0 : 1,
        'a failed run is not retried, because a retry spends more of the subscription'
      );
      assert.doesNotMatch(
        JSON.stringify(response.body) + server.logs() + JSON.stringify(harness.events),
        /STDERR-SECRET-MARKER|PROMPT-SECRET-MARKER/,
        'neither the CLI output nor the prompt reaches a response or a log'
      );
      return { response, harness };
    } finally {
      await server.close();
    }
  }

  test('the CLI exits with an error', async () => {
    const { response, harness } = await failure({ run: 'exit_error' });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'PROVIDER_UNAVAILABLE');
    assert.match(response.body.error.message, /exited with an error \(code 3\)/);
    assert.equal(harness.events.at(-1).kind, 'cli_error');
    assert.ok(harness.events.at(-1).stderr_bytes > 0);
  });

  test('output that is not JSON', async () => {
    const { response } = await failure({ run: 'malformed' });
    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, 'INVALID_PROVIDER_RESPONSE');
  });

  test('no structured output, even when the prose contains valid JSON', async () => {
    const { response } = await failure({ run: 'no_structured' });
    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, 'INVALID_PROVIDER_RESPONSE');
    assert.equal(response.body.result, undefined);
  });

  test('an answer that does not match the schema is rejected by Apayee', async () => {
    const { response } = await failure({ run: 'wrong_shape' });
    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, 'INVALID_PROVIDER_RESPONSE');
    assert.ok(Array.isArray(response.body.error.details));
  });

  test('output larger than Apayee will read', async () => {
    const { response } = await failure({ run: 'big' });
    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, 'INVALID_PROVIDER_RESPONSE');
  });

  test('a schema too large for a command line is refused before anything starts', async () => {
    const properties = Object.fromEntries(
      Array.from({ length: 700 }, (_, index) => [`field_number_${index}`, { type: 'string' }])
    );
    const { response } = await failure(
      {},
      { schema: { type: 'object', properties, required: ['field_number_0'] } }
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INVALID_SCHEMA');
  });
});

describe("Anthropic's documented error messages are classified from structured fields first", () => {
  // Strings are the ones on https://code.claude.com/docs/en/errors, not invented ones.
  const OVERLOAD =
    'API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment.';

  const cases = [
    ['not logged in', { result: 'Not logged in · Please run /login' }, 503, 'PROVIDER_NOT_READY', false, /claude:login/],
    ['login expired', { result: 'Login expired · Please run /login' }, 503, 'PROVIDER_NOT_READY', false, /claude:login/],
    ['authentication required', { result: 'Authentication required · Sign in again to continue' }, 503, 'PROVIDER_NOT_READY', false, /claude:login/],
    ['invalid API key', { result: 'Invalid API key' }, 503, 'PROVIDER_NOT_READY', false, /claude:login/],
    ['OAuth token revoked', { result: 'Failed to authenticate: OAuth token revoked' }, 503, 'PROVIDER_NOT_READY', false, /claude:login/],
    ['HTTP 401 by status field', { api_error_status: 401, result: 'API Error: 401 Invalid authentication credentials' }, 503, 'PROVIDER_NOT_READY', false, /claude:login/],
    ['session limit', { result: "You've hit your session limit" }, 429, 'PROVIDER_RATE_LIMITED', true, /usage limit.*reset/],
    ['weekly limit', { result: "You've hit your weekly limit" }, 429, 'PROVIDER_RATE_LIMITED', true, /usage limit.*reset/],
    ['Opus limit', { result: "You've hit your Opus limit" }, 429, 'PROVIDER_RATE_LIMITED', true, /usage limit.*reset/],
    ['plan limit with HTTP 429', { api_error_status: 429, result: "You've hit your weekly limit" }, 429, 'PROVIDER_RATE_LIMITED', true, /usage limit.*reset/],
    ['temporary throttling by status field', { api_error_status: 429, result: 'Server is temporarily limiting requests' }, 429, 'PROVIDER_RATE_LIMITED', true, /temporarily limiting.*retry/],
    ['request rejected (429)', { result: 'Request rejected (429)' }, 429, 'PROVIDER_RATE_LIMITED', true, /temporarily limiting.*retry/],
    ['529 by status field', { api_error_status: 529, result: OVERLOAD }, 503, 'PROVIDER_UNAVAILABLE', true, /overloaded.*does not use up/],
    ['529 by text only', { result: OVERLOAD }, 503, 'PROVIDER_UNAVAILABLE', true, /overloaded.*does not use up/],
    ['the status field wins over wording', { api_error_status: 529, result: 'Not logged in' }, 503, 'PROVIDER_UNAVAILABLE', true, /overloaded/],
    ['request timed out', { result: 'Request timed out' }, 504, 'PROVIDER_TIMEOUT', true, /did not respond in time/],
    ['no response from API', { result: 'API Error: No response from API' }, 504, 'PROVIDER_TIMEOUT', true, /did not respond in time/],
    ['structured-output attempts used up', { subtype: 'error_max_structured_output_retries', errors: [] }, 502, 'INVALID_PROVIDER_RESPONSE', true, /attempts/],
    ['structured-output terminal reason', { terminal_reason: 'structured_output_retry_exhausted', result: '' }, 502, 'INVALID_PROVIDER_RESPONSE', true, /attempts/],
    ['turn limit', { subtype: 'error_max_turns', errors: [] }, 502, 'INVALID_PROVIDER_RESPONSE', true, /turn limit/],
    ['anything else', { result: 'something unexpected' }, 503, 'PROVIDER_UNAVAILABLE', true, /exited with an error/],
  ];

  test('each maps to a distinct, accurate error', async () => {
    const harness = fakeProvider();
    const server = await startTestServer({ provider: harness.provider });
    try {
      for (const [index, [label, fields, status, code, retryable, message]] of cases.entries()) {
        behave(harness, { run: 'custom', exit: 1, fields: { is_error: true, ...fields } });
        const response = await server.post(requestBody({ request_id: `official-${index}` }));

        assert.equal(response.status, status, label);
        assert.equal(response.body.error.code, code, label);
        assert.equal(response.body.error.retryable, retryable, label);
        assert.match(response.body.error.message, message, label);
        assert.doesNotMatch(
          JSON.stringify(response.body),
          /Repeated 529|hit your|Invalid authentication|Request rejected|Please run \/login/,
          `${label}: the CLI's wording is not relayed`
        );
      }
    } finally {
      await server.close();
    }
  });

  test('an overload is never reported as an exhausted subscription allowance', async () => {
    const harness = fakeProvider({
      behaviour: { run: 'custom', exit: 1, fields: { is_error: true, api_error_status: 529, result: OVERLOAD } },
    });
    const server = await startTestServer({ provider: harness.provider });
    try {
      const { body } = await server.post(requestBody());
      assert.equal(body.error.code, 'PROVIDER_UNAVAILABLE');
      assert.doesNotMatch(body.error.message, /has been reached|wait for the limit to reset/);
    } finally {
      await server.close();
    }
  });

  test('an expired login is forgotten, so the next health check looks again', async () => {
    let now = 1_000_000;
    const harness = fakeProvider({ now: () => now });
    const server = await startTestServer({ provider: harness.provider });
    try {
      assert.equal((await health(server)).provider, 'claude');
      behave(harness, { run: 'custom', exit: 1, fields: { is_error: true, result: 'Login expired · Please run /login' } });
      await server.post(requestBody());
      await health(server);
      assert.equal(count(harness, 'status'), 2, 'the cached "ready" did not survive the auth failure');
    } finally {
      await server.close();
    }
  });
});

describe('timeouts, cancellation and cleanup', () => {
  async function expectStopped(harness, server) {
    const pid = readPid(harness.files.pidFile);
    await waitFor(() => !isAlive(pid), { timeoutMs: 5_000, label: 'the CLI process to exit' });
    await waitFor(() => server.app.queue.stats().active === 0, { label: 'the queue slot' });
    assert.equal(server.app.queue.stats().abandoned, 0);
    assert.ok(
      !harness.events.some((event) => event.event === 'claude_cli_lingering'),
      'the process was confirmed gone'
    );
  }

  test("the provider's own ceiling ends a run that hangs, and is counted as a timeout", async () => {
    const harness = fakeProvider({ behaviour: { run: 'hang' }, settings: { timeoutMs: 400 } });
    const server = await startTestServer({ provider: harness.provider });
    try {
      const response = await server.post(requestBody({ request_id: 'ceiling' }));
      assert.equal(response.status, 504);
      assert.equal(response.body.error.code, 'PROVIDER_TIMEOUT');
      await expectStopped(harness, server);
      assert.equal(server.app.queue.stats().timedOut, 1);
      assert.equal(server.app.queue.stats().failed, 0);

      behave(harness, {});
      assert.equal((await server.post(requestBody({ request_id: 'after' }))).status, 200);
    } finally {
      await server.close();
    }
  });

  test("the request's own timeout_ms ends it too", async () => {
    const harness = fakeProvider({ behaviour: { run: 'hang' } });
    const server = await startTestServer({ provider: harness.provider });
    try {
      // The first readiness probe starts the CLI twice and counts against a request's
      // budget; warm it so this measures the generation run alone.
      await harness.provider.status();

      const response = await server.post(requestBody({ request_id: 'budget', timeout_ms: 1_000 }));
      assert.equal(response.status, 504);
      assert.equal(response.body.error.code, 'PROVIDER_TIMEOUT');
      await expectStopped(harness, server);
    } finally {
      await server.close();
    }
  });

  test('a client that disconnects cancels the run and the next request still works', async () => {
    const harness = fakeProvider({ behaviour: { run: 'hang' } });
    const server = await startTestServer({ provider: harness.provider });
    try {
      const controller = new AbortController();
      const pending = server.post(requestBody({ request_id: 'leaving' }), {
        signal: controller.signal,
      });
      pending.catch(() => {});

      await waitFor(() => existsSync(harness.files.pidFile), { label: 'the CLI to start' });
      controller.abort();
      await assert.rejects(pending);

      await expectStopped(harness, server);
      assert.equal(server.app.queue.stats().cancelled, 1);

      behave(harness, {});
      assert.equal((await server.post(requestBody({ request_id: 'next' }))).status, 200);
    } finally {
      await server.close();
    }
  });

  test('a plain abort is reported as a cancellation, not as a DOM exception', async () => {
    const harness = fakeProvider({ behaviour: { run: 'hang' } });
    await harness.provider.status();
    const controller = new AbortController();

    const pending = harness.provider.generate({
      system: 's',
      prompt: 'p',
      schema: { type: 'object' },
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    pending.catch(() => {});
    await waitFor(() => existsSync(harness.files.pidFile), { label: 'the CLI to start' });
    controller.abort();

    await assert.rejects(
      pending,
      (error) => error instanceof ApiError && error.code === 'REQUEST_CANCELLED'
    );
    const pid = readPid(harness.files.pidFile);
    await waitFor(() => !isAlive(pid), { timeoutMs: 5_000, label: 'the CLI process to exit' });
  });

  test('the whole process tree is stopped, not only the CLI', async () => {
    const { dir, pidFile } = scratch();
    const grandchildPid = join(dir, 'grandchild.pid');
    const grandchild = join(dir, 'grandchild.js');
    const parent = join(dir, 'parent.js');
    writeFileSync(
      grandchild,
      `require('fs').writeFileSync(${JSON.stringify(grandchildPid)}, String(process.pid)); setInterval(()=>{},1000);`
    );
    writeFileSync(
      parent,
      `const {spawn}=require('child_process');spawn(process.execPath,[${JSON.stringify(grandchild)}],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(()=>{},1000);`
    );

    const controller = new AbortController();
    const running = runCli({ file: process.execPath, args: [parent], env: process.env, signal: controller.signal });
    await waitFor(() => existsSync(pidFile) && existsSync(grandchildPid), { label: 'both processes' });
    const pids = [readPid(pidFile), readPid(grandchildPid)];

    controller.abort();
    const result = await running;
    assert.equal(result.aborted, true);
    assert.equal(result.lingering, false);
    await waitFor(() => pids.every((pid) => !isAlive(pid)), { timeoutMs: 5_000, label: 'the tree to exit' });
  });

  test('a process that will not stop is reported as lingering, never as a clean exit', async () => {
    const files = scratch();
    const env = fakeEnvironment({ run: 'hang', pidFile: files.pidFile });
    let pid = null;

    try {
      const result = await runCli({
        file: FAKE_CLI.file,
        args: [...FAKE_CLI.args, '-p'],
        env,
        timeoutMs: 700, // long enough for the fake to start and write its pid
        retryMs: 100,
        hardCapMs: 600,
        stopProcess: () => {}, // a kill that does nothing
      });
      pid = existsSync(files.pidFile) ? readPid(files.pidFile) : null;

      assert.equal(result.timedOut, true);
      assert.equal(result.lingering, true);
      assert.equal(isAlive(pid), true, 'it really is still running');
    } finally {
      // The test cleans up after itself even when an assertion fails.
      if (pid !== null && isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
    await waitFor(() => !isAlive(pid), { timeoutMs: 5_000, label: 'the stray process to exit' });
  });

  test('shutting down the service stops a run in progress', async () => {
    const harness = fakeProvider({ behaviour: { run: 'hang' } });
    const server = await startTestServer({ provider: harness.provider });
    const pending = server.post(requestBody({ request_id: 'shutdown' })).catch((error) => error);

    await waitFor(() => existsSync(harness.files.pidFile), { label: 'the CLI to start' });
    await server.close();
    await pending;

    const pid = readPid(harness.files.pidFile);
    await waitFor(() => !isAlive(pid), { timeoutMs: 5_000, label: 'the CLI process to exit' });
  });
});

describe('the login, status and smoke commands', () => {
  const collect = () => {
    const lines = [];
    return { lines, out: (line) => lines.push(line) };
  };

  test('login starts the official interactive login and nothing else', async () => {
    const { lines, out } = collect();
    const started = [];

    const code = await login({
      settings: claudeSettings(),
      env: cleanEnvironment({ APAYEE_AUTH_TOKEN: TEST_TOKEN, SECRET_THING: 'never-passed', TERM: 'xterm' }),
      cli: FAKE_CLI,
      out,
      interactive: async (invocation) => {
        started.push(invocation);
        return 0;
      },
    });

    assert.equal(code, 0);
    assert.equal(started.length, 1);
    assert.deepEqual(started[0].args.slice(FAKE_CLI.args.length), ['auth', 'login']);
    assert.ok(!started[0].args.includes('--console'));
    const names = Object.keys(started[0].env).map((name) => name.toUpperCase());
    assert.ok(!names.some((name) => name.startsWith('APAYEE_')));
    assert.ok(!names.includes('SECRET_THING'), 'only the allowlist reaches the login');
    assert.ok(names.includes('TERM'), 'the interactive login keeps its terminal');

    const text = lines.join('\n');
    assert.match(text, /account settings/);
    assert.match(text, /APAYEE_CLAUDE_SUBSCRIPTION_CONFIRMED/);
    assert.match(text, /your own statement/);
    assert.doesNotMatch(text, /names your Claude Pro plan|\/status/);
  });

  test('login refuses to run while an API key is set', async () => {
    const { lines, out } = collect();
    let started = false;

    const code = await login({
      settings: claudeSettings(),
      env: cleanEnvironment({ ANTHROPIC_API_KEY: 'sk-ant-never-shown' }),
      cli: FAKE_CLI,
      out,
      interactive: async () => {
        started = true;
        return 0;
      },
    });

    assert.equal(code, 1);
    assert.equal(started, false);
    assert.match(lines.join('\n'), /ANTHROPIC_API_KEY/);
    assert.doesNotMatch(lines.join('\n'), /never-shown/);
  });

  test('login says so when the CLI is missing', async () => {
    const { lines, out } = collect();
    const code = await login({
      settings: claudeSettings({ cliPath: join(scratch().dir, 'missing.exe') }),
      env: cleanEnvironment(),
      out,
      interactive: async () => 0,
    });
    assert.equal(code, 1);
    assert.match(lines.join('\n'), /APAYEE_CLAUDE_CLI_PATH/);
  });

  test('status prints a short, whitelisted summary, never account details, and no plan claim', async () => {
    const files = scratch();
    const env = fakeEnvironment({
      log: files.log,
      auth: {
        loggedIn: true,
        authMethod: 'claude.ai',
        email: 'owner@example.com',
        accessToken: 'tok-SECRET-VALUE',
        configDirectory: 'C:\\Users\\owner\\.claude',
      },
    });

    const attested = collect();
    const code = await showStatus({
      settings: claudeSettings(),
      env,
      cli: FAKE_CLI,
      out: attested.out,
    });
    const text = attested.lines.join('\n');

    assert.equal(code, 0);
    assert.match(text, /READY\s+: yes/);
    assert.match(text, /claude\.ai/);
    assert.match(text, /plan attested by you\s+: yes\s+\(your statement; not verified\)/);
    assert.match(text, /account settings/);
    assert.doesNotMatch(text, /owner@example|SECRET/);
    assert.doesNotMatch(text, /names your|look for your/i);

    const unattested = collect();
    assert.equal(
      await showStatus({
        settings: claudeSettings({ subscriptionConfirmed: false }),
        env,
        cli: FAKE_CLI,
        out: unattested.out,
      }),
      2
    );
    assert.match(unattested.lines.join('\n'), /subscription_unconfirmed/);
  });

  test('smoke sends nothing without its own explicit opt-in', async () => {
    const harness = fakeProvider();
    const { lines, out } = collect();

    const code = await smoke({
      config: { claude: claudeSettings() },
      env: harness.env,
      cli: FAKE_CLI,
      out,
    });

    assert.equal(code, 2);
    assert.match(lines.join('\n'), /REAL request/);
    assert.deepEqual(harness.calls(), []);
  });

  test('smoke sends exactly one request once opted in, warns first, and prints sanitized evidence', async () => {
    const harness = fakeProvider({
      env: { APAYEE_CLAUDE_SMOKE: '1' },
      behaviour: { auth: { loggedIn: true, authMethod: 'claude.ai', email: 'owner@example.com' } },
    });
    const { lines, out } = collect();

    const code = await smoke({
      config: { claude: claudeSettings() },
      env: harness.env,
      cli: FAKE_CLI,
      out,
      clock: () => new Date('2026-11-02T10:00:00.000Z'),
    });

    assert.equal(code, 0, lines.join('\n'));
    assert.equal(harness.prints().length, 1, 'exactly one model request');
    const text = lines.join('\n');
    assert.ok(text.indexOf('WARNING') < text.indexOf('Reply'));
    for (const expected of [
      /timestamp\s+: 2026-11-02T10:00:00\.000Z/,
      /CLI version\s+: 2\.1\.314/,
      /auth method\s+: claude\.ai/,
      /readiness\s+: ready/,
      /API\/provider env\s+: none detected/,
      /exit code\s+: 0/,
      /schema valid\s+: yes/,
      /num_turns\s+: 2/,
      /tokens in\/out\s+: 11 \/ 7/,
      /classification\s+: success/,
    ]) {
      assert.match(text, expected);
    }
    assert.doesNotMatch(text, /owner@example|Return the single word|PROMPT/, 'no account detail, no prompt');
  });

  test('smoke reports a failure with its classification and never tries again', async () => {
    const harness = fakeProvider({
      env: { APAYEE_CLAUDE_SMOKE: '1' },
      behaviour: { run: 'custom', exit: 1, fields: { is_error: true, result: "You've hit your session limit", num_turns: 1 } },
    });
    const { lines, out } = collect();

    const code = await smoke({ config: { claude: claudeSettings() }, env: harness.env, cli: FAKE_CLI, out });

    assert.equal(code, 1);
    assert.equal(harness.prints().length, 1, 'one request, no retry after a failure');
    const text = lines.join('\n');
    assert.match(text, /classification\s+: usage_limit/);
    assert.match(text, /num_turns\s+: 1/);
  });

  test('smoke names the open question about --tools "" when no structured output comes back', async () => {
    const harness = fakeProvider({
      env: { APAYEE_CLAUDE_SMOKE: '1' },
      behaviour: { run: 'no_structured' },
    });
    const { lines, out } = collect();

    assert.equal(await smoke({ config: { claude: claudeSettings() }, env: harness.env, cli: FAKE_CLI, out }), 1);
    assert.match(lines.join('\n'), /StructuredOutput/);
    assert.equal(harness.prints().length, 1);
  });

  test('smoke does nothing when the provider is not ready, and says why', async () => {
    const harness = fakeProvider({ env: { APAYEE_CLAUDE_SMOKE: '1' } });
    const { lines, out } = collect();

    const code = await smoke({
      config: { claude: claudeSettings({ subscriptionConfirmed: false }) },
      env: harness.env,
      cli: FAKE_CLI,
      out,
    });

    assert.equal(code, 2);
    assert.deepEqual(harness.calls(), [], 'not even a probe');
    assert.match(lines.join('\n'), /readiness\s+: subscription_unconfirmed/);
  });
});

describe('the provider contract', () => {
  test('a ClaudeProvider is an ordinary provider that throws ApiError', async () => {
    const harness = fakeProvider({ settings: { experimental: false } });
    await assert.rejects(
      harness.provider.generate({
        system: 's',
        prompt: 'p',
        schema: { type: 'object' },
        signal: new AbortController().signal,
        timeoutMs: 1_000,
      }),
      (error) => error instanceof ApiError && error.code === 'PROVIDER_NOT_READY'
    );
    assert.equal(harness.provider.name, 'claude');
    assert.equal(harness.provider.supportsTask('anything_valid'), true);
    assert.ok(harness.provider instanceof ClaudeProvider);
  });
});

describe('documentation makes only claims the evidence supports', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const docs = ['README.md', 'docs/CLAUDE_PROVIDER.md', '.env.example'];

  test('no document says that the CLI or /status proves or names the plan', () => {
    for (const path of docs) {
      assert.doesNotMatch(
        read(path),
        /names your Claude Pro plan|look for your Claude Pro plan|shows your Claude Pro plan|\/status[^.\n]*Pro plan/i,
        path
      );
    }
    assert.match(read('docs/CLAUDE_PROVIDER.md'), /account settings/);
    assert.match(read('docs/CLAUDE_PROVIDER.md'), /attest/i);
    assert.match(read('.env.example'), /account settings/);
  });

  test('the retry behaviour is described accurately', () => {
    const text = read('docs/CLAUDE_PROVIDER.md');
    assert.doesNotMatch(text, /It does not retry/);
    assert.match(text, /MAX_STRUCTURED_OUTPUT_RETRIES/);
    assert.match(text, /num_turns/);
  });

  test('the version floor is explained by its evidence', () => {
    const text = read('docs/CLAUDE_PROVIDER.md');
    for (const evidence of ['2.1.299', '2.1.286', '2.1.289']) assert.match(text, new RegExp(evidence));
  });
});
