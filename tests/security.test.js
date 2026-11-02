import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ConfigError, isLoopbackHost, loadConfig } from '../src/config.js';
import { availableProviders, createProvider } from '../src/providers/registry.js';
import { startServer } from '../src/server.js';
import { TEST_TOKEN, requestBody, startTestServer } from './helpers/harness.js';

describe('binding and remote access', () => {
  test('binds to loopback by default', () => {
    const config = loadConfig({});
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.allowRemote, false);
    assert.equal(config.authToken, null);
  });

  test('the running server listens on loopback only by default', async () => {
    const { app, address, shutdown } = await startServer({
      env: { APAYEE_PORT: '0', APAYEE_LOG_LEVEL: 'silent' },
      signals: new (await import('node:events')).EventEmitter(),
    });
    try {
      assert.match(address, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(app.server.address().address, '127.0.0.1');
    } finally {
      await shutdown();
    }
  });

  for (const host of ['0.0.0.0', '192.168.1.10', '::', 'apayee.internal']) {
    test(`refuses ${host} without opt-in, even with a token`, () => {
      assert.throws(
        () => loadConfig({ APAYEE_HOST: host, APAYEE_AUTH_TOKEN: TEST_TOKEN }),
        (error) => error instanceof ConfigError && /APAYEE_ALLOW_REMOTE/.test(error.message)
      );
    });

    test(`refuses ${host} with opt-in but no token`, () => {
      assert.throws(
        () => loadConfig({ APAYEE_HOST: host, APAYEE_ALLOW_REMOTE: 'true' }),
        (error) => error instanceof ConfigError && /APAYEE_AUTH_TOKEN/.test(error.message)
      );
    });
  }

  test('allows remote binding with opt-in and a strong token', () => {
    const config = loadConfig({
      APAYEE_HOST: '0.0.0.0',
      APAYEE_ALLOW_REMOTE: 'true',
      APAYEE_AUTH_TOKEN: TEST_TOKEN,
    });
    assert.equal(config.host, '0.0.0.0');
  });

  const weakTokens = {
    short: 'abc123',
    repetitive: 'a'.repeat(40),
    placeholder: 'change-me-change-me-change-me-change-me-1234',
    whitespace: 'abcdefghij klmnopqrstuvwxyz 0123456789',
  };
  for (const [name, token] of Object.entries(weakTokens)) {
    test(`refuses a ${name} token, and does not quote it`, () => {
      for (const env of [
        { APAYEE_AUTH_TOKEN: token },
        { APAYEE_HOST: '0.0.0.0', APAYEE_ALLOW_REMOTE: 'true', APAYEE_AUTH_TOKEN: token },
      ]) {
        assert.throws(
          () => loadConfig(env),
          (error) => error instanceof ConfigError && !error.message.includes(token)
        );
      }
    });
  }

  test('classifies loopback addresses', () => {
    for (const host of [
      '127.0.0.1',
      '127.8.8.8',
      'localhost',
      'LOCALHOST',
      '::1',
      '::ffff:127.0.0.1',
    ]) {
      assert.equal(isLoopbackHost(host), true, host);
    }
    for (const host of ['0.0.0.0', '::', '10.0.0.1', '127.example.com', '1270.0.0.1', '']) {
      assert.equal(isLoopbackHost(host), false, host);
    }
  });

  const badValues = {
    APAYEE_PORT: '70000',
    APAYEE_MAX_QUEUE_SIZE: '-1',
    APAYEE_MAX_TIMEOUT_MS: '3000000000', // would overflow setTimeout and fire at once
    APAYEE_DEFAULT_TIMEOUT_MS: 'soon',
    APAYEE_ALLOW_REMOTE: 'yes',
    APAYEE_LOG_LEVEL: 'loud',
  };
  for (const [name, value] of Object.entries(badValues)) {
    test(`refuses ${name}=${value} rather than using a default`, () => {
      assert.throws(() => loadConfig({ [name]: value }), ConfigError);
    });
  }

  test('refuses a default timeout above the maximum', () => {
    assert.throws(
      () => loadConfig({ APAYEE_DEFAULT_TIMEOUT_MS: '200', APAYEE_MAX_TIMEOUT_MS: '100' }),
      ConfigError
    );
  });
});

describe('authentication', () => {
  async function withAuthServer(run) {
    const server = await startTestServer({ config: { authToken: TEST_TOKEN } });
    try {
      await run(server);
    } finally {
      await server.close();
    }
  }

  const wrongHeaders = {
    'no header': {},
    'the wrong token': { authorization: `Bearer ${TEST_TOKEN}x` },
    'a prefix of the token': { authorization: `Bearer ${TEST_TOKEN.slice(0, 10)}` },
    'the wrong scheme': { authorization: `Basic ${TEST_TOKEN}` },
    'an empty bearer': { authorization: 'Bearer ' },
  };
  for (const [name, headers] of Object.entries(wrongHeaders)) {
    test(`rejects ${name} on generate and health`, () =>
      withAuthServer(async (server) => {
        const generate = await server.post(requestBody(), { headers });
        assert.equal(generate.status, 401);
        assert.equal(generate.body.error.code, 'UNAUTHORIZED');
        assert.equal(generate.headers.get('www-authenticate'), 'Bearer');
        assert.equal(server.app.queue.stats().succeeded, 0);

        const health = await fetch(`${server.baseUrl}/v1/health`, { headers });
        assert.equal(health.status, 401);
      }));
  }

  test('accepts the right token', () =>
    withAuthServer(async (server) => {
      const headers = { authorization: `Bearer ${TEST_TOKEN}` };
      assert.equal((await server.post(requestBody(), { headers })).status, 200);
      assert.equal((await fetch(`${server.baseUrl}/v1/health`, { headers })).status, 200);
    }));

  test('an unauthorized caller is refused before the body is considered', () =>
    withAuthServer(async (server) => {
      const response = await server.post('{ not even json');
      assert.equal(response.status, 401);
    }));

  test('tokens never appear in logs or responses', () =>
    withAuthServer(async (server) => {
      const wrongToken = 'wrong-TOKEN-canary-0123456789-abcdefghijkl';

      const denied = await server.post(requestBody(), {
        headers: { authorization: `Bearer ${wrongToken}` },
      });
      const allowed = await server.post(requestBody(), {
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      const health = await fetch(`${server.baseUrl}/v1/health`, {
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });

      const everything = [
        server.logs(),
        JSON.stringify(denied.body),
        JSON.stringify(allowed.body),
        await health.text(),
      ].join('\n');

      assert.ok(!everything.includes(TEST_TOKEN));
      assert.ok(!everything.includes(wrongToken));
    }));
});

describe('browser requests', () => {
  test('rejects any request with an Origin header', async () => {
    const server = await startTestServer();
    try {
      const response = await server.post(requestBody(), {
        headers: { origin: 'https://evil.example' },
      });
      assert.equal(response.status, 403);
      assert.equal(response.body.error.code, 'FORBIDDEN_ORIGIN');
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    } finally {
      await server.close();
    }
  });

  test('sends no CORS headers, and does not answer a preflight', async () => {
    const server = await startTestServer();
    try {
      const preflight = await fetch(`${server.baseUrl}/v1/generate`, {
        method: 'OPTIONS',
        headers: { 'access-control-request-method': 'POST' },
      });
      assert.equal(preflight.headers.get('access-control-allow-origin'), null);
      assert.ok(preflight.status >= 400);
    } finally {
      await server.close();
    }
  });
});

describe('sensitive content in logs', () => {
  test('prompts, system text, schemas and results are not logged at any outcome', async () => {
    const server = await startTestServer({ config: { logLevel: 'trace' } });
    try {
      const canaries = {
        system: 'CANARY-SYSTEM-TEXT',
        prompt: 'CANARY-PROMPT-TEXT',
        schema: {
          type: 'object',
          description: 'CANARY-SCHEMA-TEXT',
          required: ['answer'],
          properties: { answer: { const: 'CANARY-RESULT-TEXT' } },
        },
      };

      const success = await server.post(requestBody(canaries));
      assert.equal(success.body.result.answer, 'CANARY-RESULT-TEXT');

      await server.post(requestBody({ ...canaries, request_id: 'bad', task: 'CANARY INVALID' }));
      await server.post(
        requestBody({ ...canaries, request_id: 'bad2', schema: { type: 'CANARY-SCHEMA-TEXT' } })
      );

      assert.doesNotMatch(server.logs(), /CANARY/);
    } finally {
      await server.close();
    }
  });

  test('logs the operational metadata that was promised', async () => {
    const server = await startTestServer();
    try {
      await server.post(requestBody({ request_id: 'logged-1' }));
      await server.post(requestBody({ request_id: 'logged-2', prompt: '' }));

      const lines = server
        .logs()
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const success = lines.find((line) => line.request_id === 'logged-1');
      assert.equal(success.task, 'generic');
      assert.equal(success.provider, 'mock');
      assert.equal(success.status, 'success');
      assert.ok(Number.isInteger(success.queue_wait_ms));
      assert.ok(Number.isInteger(success.execution_time_ms));

      const failure = lines.find((line) => line.request_id === 'logged-2');
      assert.equal(failure.status, 'error');
      assert.equal(failure.error_code, 'INVALID_REQUEST');
    } finally {
      await server.close();
    }
  });

  test('failure responses carry no stack traces or paths', async () => {
    const server = await startTestServer();
    try {
      const responses = await Promise.all([
        server.post('{ bad json'),
        server.post(requestBody({ schema: { type: 'nope' } })),
        server.post(requestBody({ prompt: 42 })),
      ]);
      for (const { body } of responses) {
        assert.doesNotMatch(JSON.stringify(body), /node_modules|[A-Za-z]:\\\\|\.js:\d+|\bat .+\(/);
      }
    } finally {
      await server.close();
    }
  });
});

describe('no arbitrary execution', () => {
  function sourceFiles(directory) {
    return readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.js') ? [path] : [];
    });
  }

  const source = fileURLToPath(new URL('../src', import.meta.url));
  const strip = (file) =>
    // Comments are stripped because JSDoc types are written as import('./x.js').
    readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  /** The one module that may start another program: the Claude CLI provider's runner. */
  const isRunner = (file) => file.replaceAll('\\', '/').endsWith('src/providers/claude/cli.js');
  const inClaudeProvider = (file) => file.replaceAll('\\', '/').includes('src/providers/claude/');

  test('no eval or dynamic import anywhere in the source', () => {
    for (const file of sourceFiles(source)) {
      assert.doesNotMatch(strip(file), /\beval\(|new Function|\bimport\(/, file);
    }
  });

  test('the scripts start no process and read no credential: they only call the source', () => {
    const scripts = fileURLToPath(new URL('../scripts', import.meta.url));
    const forbidden =
      /child_process|(?<!\.)\bexec(?:Sync|File)?\(|\bspawn(?:Sync)?\(|readFile(?:Sync)?\(|\.credentials|\bfetch\(/;

    for (const file of sourceFiles(scripts)) {
      assert.doesNotMatch(strip(file), forbidden, file);
    }
  });

  test('only the Claude CLI runner starts a process, and never through a shell', () => {
    const processes = /child_process|(?<!\.)\bexec(?:Sync|File)?\(|\bspawn(?:Sync)?\(/;

    let runners = 0;
    for (const file of sourceFiles(source)) {
      const code = strip(file);
      if (!isRunner(file)) {
        assert.doesNotMatch(code, processes, file);
        continue;
      }

      runners += 1;
      assert.match(code, /spawn\(/);
      assert.doesNotMatch(code, /(?<!\.)\bexec(?:Sync|File)?\(/, 'no command-string execution');
      assert.doesNotMatch(code, /shell:\s*true/, 'no shell');
      assert.match(code, /shell:\s*false/);
    }
    assert.equal(runners, 1);
  });

  test('Anthropic and Claude appear only in the provider that is built for them', () => {
    const allowed = (file) =>
      inClaudeProvider(file) || /src[\\/]config\.js$|registry\.js$|health\.js$/.test(file);

    for (const file of sourceFiles(source)) {
      if (!allowed(file)) assert.doesNotMatch(readFileSync(file, 'utf8'), /anthropic|claude/i, file);
    }
  });

  test('there is no API client, API key support or credential handling', () => {
    const forbidden =
      /@anthropic-ai|api\.anthropic\.com|x-api-key|anthropic-version|\.credentials|\.claude\.json|keychain|readFile(?:Sync)?\(|createReadStream|\bfetch\(|https?\.request|\bnet\.connect/i;

    for (const file of sourceFiles(source)) {
      assert.doesNotMatch(strip(file), forbidden, file);
    }
  });

  test('the Claude provider is never given an API key or a different billing mode', () => {
    for (const file of sourceFiles(source).filter(inClaudeProvider)) {
      const code = strip(file);
      assert.doesNotMatch(code, /['"`]--(?:console|bare)['"`]/, `${file} passes --console or --bare`);
      assert.doesNotMatch(code, /['"`]--(?:continue|resume)['"`]/, file);
    }
  });

  test('shell syntax in a request is inert data', async () => {
    const server = await startTestServer();
    try {
      const response = await server.post(
        requestBody({ system: '$(touch /tmp/x)', prompt: '`calc.exe`; rm -rf / & del /q *' })
      );
      assert.equal(response.status, 200);
    } finally {
      await server.close();
    }
  });

  test('only registered providers can be created', () => {
    assert.deepEqual(availableProviders(), ['mock', 'claude']);
    for (const name of ['../../evil', 'Claude', 'claude ', 'constructor', '__proto__', 'toString']) {
      assert.throws(() => createProvider(name), ConfigError, name);
    }
  });

  test('an unknown provider stops startup with a clear error', async () => {
    await assert.rejects(
      startServer({
        env: { APAYEE_PROVIDER: 'nope', APAYEE_LOG_LEVEL: 'silent', APAYEE_PORT: '0' },
      }),
      (error) =>
        error instanceof ConfigError && /nope/.test(error.message) && /mock/.test(error.message)
    );
  });
});
