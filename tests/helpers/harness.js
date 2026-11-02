import { Writable } from 'node:stream';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';

export const TEST_TOKEN = 'k3Jq9vX2mZpL7wRt5YbN8cFh4sGd1aEu6Tq0';

export const OBJECT_SCHEMA = {
  type: 'object',
  required: ['answer'],
  properties: { answer: { type: 'string' } },
};

export function testConfig(overrides = {}) {
  return { ...loadConfig({}), port: 0, logLevel: 'info', ...overrides };
}

export function requestBody(overrides = {}) {
  return {
    request_id: 'req-1',
    task: 'generic',
    system: 'system text',
    prompt: 'prompt text',
    schema: OBJECT_SCHEMA,
    ...overrides,
  };
}

/** A real Fastify server on a real socket, with its log output captured. */
export async function startTestServer({ provider, config: overrides } = {}) {
  const config = testConfig(overrides);
  let logs = '';
  const logStream = new Writable({
    write(chunk, _encoding, done) {
      logs += chunk.toString();
      done();
    },
  });

  const app = await buildApp({ config, provider, logStream });
  const baseUrl = await app.listen({ host: config.host, port: 0 });

  let closed = false;
  return {
    app,
    baseUrl,
    logs: () => logs,
    post: (body, init = {}) => postJson(baseUrl, body, init),
    close: async () => {
      if (!closed) await app.close();
      closed = true;
    },
  };
}

export async function postJson(baseUrl, body, { headers, signal, path = '/v1/generate' } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal,
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

/** Polls instead of sleeping for a guessed duration. */
export async function waitFor(condition, { timeoutMs = 3_000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
