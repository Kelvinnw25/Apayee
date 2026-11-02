import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ApiError, ERROR_CATALOG } from '../src/errors.js';
import { MockProvider } from '../src/providers/mock/mock.provider.js';
import { OBJECT_SCHEMA, requestBody, startTestServer, waitFor } from './helpers/harness.js';

function assertFailure(response, status, code) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.equal(response.body.status, 'error');
  assert.equal(response.body.error.code, code);
  assert.equal(typeof response.body.error.message, 'string');
  assert.equal(typeof response.body.error.retryable, 'boolean');
  assert.ok('request_id' in response.body);
}

describe('GET /v1/health', () => {
  let server;
  before(async () => (server = await startTestServer()));
  after(() => server.close());

  test('reports operational state and nothing sensitive', async () => {
    const response = await fetch(`${server.baseUrl}/v1/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.provider, 'mock');
    assert.equal(body.version, '0.1.0');
    assert.equal(body.queue.length, 0);
    assert.equal(body.queue.running, false);

    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /[A-Za-z]:\\\\|\/home\/|\/Users\/|Desktop|token|env/i);
  });
});

describe('POST /v1/generate', () => {
  let server;
  before(async () => (server = await startTestServer()));
  after(() => server.close());

  test('returns the normalized success shape', async () => {
    const response = await server.post(requestBody({ request_id: 'run-001-stage-1' }));

    assert.equal(response.status, 200);
    assert.equal(response.body.request_id, 'run-001-stage-1');
    assert.equal(response.body.status, 'success');
    assert.equal(response.body.provider, 'mock');
    assert.equal(typeof response.body.result.answer, 'string');
    for (const field of ['queue_wait_ms', 'execution_time_ms', 'total_time_ms']) {
      assert.ok(Number.isInteger(response.body.metadata[field]), field);
    }
  });

  test('repeated requests get identical results', async () => {
    const first = await server.post(requestBody({ request_id: 'det-1' }));
    const second = await server.post(requestBody({ request_id: 'det-2' }));
    assert.deepEqual(first.body.result, second.body.result);
  });

  const invalid = {
    'missing request_id': { request_id: undefined },
    'request_id with a newline': { request_id: 'a\nb' },
    'over-long request_id': { request_id: 'x'.repeat(129) },
    'missing task': { task: undefined },
    'non-string system': { system: 42 },
    'non-string prompt': { prompt: ['x'] },
    'empty prompt': { prompt: '' },
    'missing schema': { schema: undefined },
    'array schema': { schema: [] },
    'string timeout that coercion would accept': { timeout_ms: '100' },
    'zero timeout': { timeout_ms: 0 },
    'fractional timeout': { timeout_ms: 1.5 },
    'timeout above the server maximum': { timeout_ms: 600_001 },
    'a client trying to choose a provider': { provider: 'claude' },
    'a client trying to inject test controls': { latencyMs: 1000 },
  };
  for (const [name, overrides] of Object.entries(invalid)) {
    test(`rejects ${name}`, async () => {
      const before = server.app.queue.stats();
      const response = await server.post(requestBody(overrides));
      assertFailure(response, 400, 'INVALID_REQUEST');
      assert.equal(server.app.queue.stats().succeeded, before.succeeded, 'must not be executed');
    });
  }

  test('echoes a valid request_id on a failure, but not an unsafe one', async () => {
    const valid = await server.post(requestBody({ request_id: 'keep-me', prompt: '' }));
    assert.equal(valid.body.request_id, 'keep-me');

    const unsafe = await server.post(requestBody({ request_id: 'a\nb' }));
    assert.equal(unsafe.body.request_id, null);
  });

  test('rejects malformed JSON in the normal failure shape', async () => {
    assertFailure(await server.post('{ not json'), 400, 'INVALID_REQUEST');
  });

  test('rejects __proto__ in the body', async () => {
    const raw = `{"__proto__":{"polluted":true},"request_id":"p","task":"generic","system":"","prompt":"x","schema":{}}`;
    assertFailure(await server.post(raw), 400, 'INVALID_REQUEST');
    assert.equal({}.polluted, undefined);
  });

  test('rejects a non-JSON content type', async () => {
    const response = await fetch(`${server.baseUrl}/v1/generate`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify(requestBody()),
    });
    assertFailure(
      { status: response.status, body: await response.json() },
      415,
      'UNSUPPORTED_MEDIA_TYPE'
    );
  });

  test('unknown routes use the failure shape', async () => {
    const response = await fetch(`${server.baseUrl}/v1/nope`);
    assertFailure({ status: response.status, body: await response.json() }, 404, 'NOT_FOUND');
  });

  test('an unknown task is rejected by the mock provider', async () => {
    const response = await server.post(requestBody({ task: 'delete_everything' }));
    assertFailure(response, 400, 'UNSUPPORTED_TASK');
    assert.equal(response.body.request_id, 'req-1');
  });
});

describe('client JSON Schema validation', () => {
  let server;
  before(async () => (server = await startTestServer()));
  after(() => server.close());

  const nested = (depth) => {
    let schema = { type: 'object' };
    for (let index = 0; index < depth; index += 1) {
      schema = { type: 'object', properties: { a: schema } };
    }
    return schema;
  };

  const rejected = {
    'an unknown type': { type: 'nonsense' },
    'a keyword of the wrong type': { type: 'object', required: 'answer' },
    'an external $ref, which must not be fetched': { $ref: 'https://example.invalid/schema.json' },
    'an unresolvable local $ref': { $ref: '#/definitions/missing' },
    'an unsupported dialect': { $schema: 'http://json-schema.org/draft-04/schema#' },
    'a non-object root': { type: 'string' },
    'a pattern keyword': {
      type: 'object',
      properties: { a: { type: 'string', pattern: '^(a+)+$' } },
    },
    patternProperties: { type: 'object', patternProperties: { '^x': { type: 'string' } } },
    'an $async schema': { $async: true, type: 'object' },
    'excessive nesting': nested(40),
  };
  for (const [name, schema] of Object.entries(rejected)) {
    test(`rejects ${name}`, async () => {
      const response = await server.post(requestBody({ schema }));
      assertFailure(response, 400, 'INVALID_SCHEMA');
    });
  }

  test('survives nesting deep enough to overflow a recursive walker', async () => {
    // Sent as raw text, because JSON.stringify itself overflows on this input.
    const depth = 100_000;
    const open = '{"type":"object","properties":{"a":';
    const schema = `${open.repeat(depth)}{}${'}}'.repeat(depth)}`;
    const raw = `{"request_id":"deep","task":"generic","system":"","prompt":"x","schema":${schema}}`;

    assertFailure(await server.post(raw), 400, 'INVALID_SCHEMA');
    assert.equal((await server.post(requestBody({ request_id: 'after-deep' }))).status, 200);
  });

  test('accepts a large flat schema, which overflowed the compiler under allErrors: false', async () => {
    const properties = Object.fromEntries(
      Array.from({ length: 5_000 }, (_, index) => [`p${index}`, { type: 'string' }])
    );
    const response = await server.post(
      requestBody({ request_id: 'flat', schema: { type: 'object', properties } })
    );
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 200));
  });

  test('a schema at the default size limit is accepted', async () => {
    const properties = Object.fromEntries(
      Array.from({ length: 9_000 }, (_, index) => [`p${index}`, { type: 'string' }])
    );
    const schema = { type: 'object', properties };
    assert.ok(JSON.stringify(schema).length < 262_144);
    assert.ok(JSON.stringify(schema).length > 200_000);

    const response = await server.post(requestBody({ request_id: 'at-limit', schema }));
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 200));
  });

  test('reports a bounded number of output errors', async () => {
    const required = Array.from({ length: 200 }, (_, index) => `p${index}`);
    const limited = await startTestServer({ provider: new MockProvider({ output: {} }) });
    try {
      const response = await limited.post(requestBody({ schema: { type: 'object', required } }));
      assertFailure(response, 502, 'INVALID_PROVIDER_RESPONSE');
      assert.equal(response.body.error.details.length, 20);
    } finally {
      await limited.close();
    }
  });

  test('rejects a schema larger than the limit', async () => {
    const limited = await startTestServer({ config: { maxSchemaBytes: 100 } });
    try {
      const schema = { type: 'object', description: 'x'.repeat(200) };
      assertFailure(await limited.post(requestBody({ schema })), 400, 'INVALID_SCHEMA');
    } finally {
      await limited.close();
    }
  });

  const accepted = {
    'an empty schema': {},
    'draft-07 explicitly': { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' },
    'draft 2020-12, as Zod 4 emits': {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' } },
    },
    'a property that happens to be named pattern': {
      type: 'object',
      required: ['pattern'],
      properties: { pattern: { type: 'string' } },
    },
    'QATOOL-style union types and annotations': {
      type: 'object',
      propertyOrdering: ['a'],
      required: ['a'],
      properties: {
        a: { type: ['string', 'null'], enum: ['valid', 'invalid', null], description: 'x' },
      },
    },
    'a local $ref': {
      type: 'object',
      required: ['a'],
      properties: { a: { $ref: '#/definitions/thing' } },
      definitions: { thing: { type: 'integer', minimum: 3 } },
    },
    'a known format': {
      type: 'object',
      required: ['d'],
      properties: { d: { type: 'string', enum: ['2026-10-31'], format: 'date' } },
    },
    'an array root': { type: 'array', minItems: 1, items: { type: 'string' } },
  };
  for (const [name, schema] of Object.entries(accepted)) {
    test(`accepts ${name}`, async () => {
      const response = await server.post(requestBody({ request_id: 'accept-1', schema }));
      assert.equal(response.status, 200, JSON.stringify(response.body));
    });
  }

  test('the same $id can be sent repeatedly', async () => {
    const schema = { $id: 'https://apayee.test/s', type: 'object' };
    for (const id of ['id-1', 'id-2']) {
      const response = await server.post(requestBody({ request_id: id, schema }));
      assert.equal(response.status, 200, JSON.stringify(response.body));
    }
  });

  test('the schema reaches the provider unchanged', async () => {
    let received;
    const spying = await startTestServer({
      provider: new MockProvider({ onCall: (request) => (received = request) }),
    });
    try {
      const schema = { ...OBJECT_SCHEMA, description: 'kept', propertyOrdering: ['answer'] };
      await spying.post(requestBody({ schema, timeout_ms: 1234 }));
      assert.deepEqual(received.schema, schema);
      assert.equal(received.timeoutMs, 1234);
      assert.ok(received.signal instanceof AbortSignal);
    } finally {
      await spying.close();
    }
  });
});

describe('provider output is validated', () => {
  const invalidOutputs = {
    'a result missing a required field': { other: 1 },
    'a field of the wrong type': { answer: 42 },
    'Markdown-wrapped JSON': '```json\n{"answer":"x"}\n```',
    'a bare JSON string': '{"answer":"x"}',
    null: null,
    nothing: undefined,
    'a number': 7,
  };

  for (const [name, output] of Object.entries(invalidOutputs)) {
    test(`rejects ${name}`, async () => {
      const server = await startTestServer({ provider: new MockProvider({ output }) });
      try {
        const response = await server.post(requestBody());
        assertFailure(response, 502, 'INVALID_PROVIDER_RESPONSE');
        assert.equal(response.body.error.retryable, true);
        assert.equal(response.body.request_id, 'req-1');
      } finally {
        await server.close();
      }
    });
  }

  test('rejects Markdown-wrapped JSON even when the schema allows anything', async () => {
    const server = await startTestServer({
      provider: new MockProvider({ output: '```json\n{}\n```' }),
    });
    try {
      assertFailure(
        await server.post(requestBody({ schema: {} })),
        502,
        'INVALID_PROVIDER_RESPONSE'
      );
    } finally {
      await server.close();
    }
  });

  test('enforces format keywords on output', async () => {
    const schema = { type: 'object', properties: { d: { type: 'string', format: 'date' } } };
    const bad = await startTestServer({
      provider: new MockProvider({ output: { d: 'not-a-date' } }),
    });
    const good = await startTestServer({
      provider: new MockProvider({ output: { d: '2026-10-31' } }),
    });
    try {
      assertFailure(await bad.post(requestBody({ schema })), 502, 'INVALID_PROVIDER_RESPONSE');
      assert.equal((await good.post(requestBody({ schema }))).status, 200);
    } finally {
      await bad.close();
      await good.close();
    }
  });

  test('rejects output that cannot be serialized', async () => {
    const circular = { answer: 'x' };
    circular.self = circular;
    const server = await startTestServer({ provider: new MockProvider({ output: circular }) });
    try {
      assertFailure(await server.post(requestBody()), 502, 'INVALID_PROVIDER_RESPONSE');
    } finally {
      await server.close();
    }
  });

  test('validates what is delivered, not what the provider held', async () => {
    // JSON turns the Date into a string, so a schema requiring an object must fail.
    const server = await startTestServer({
      provider: new MockProvider({ output: { answer: new Date(0) } }),
    });
    try {
      const schema = { type: 'object', properties: { answer: { type: 'object' } } };
      assertFailure(await server.post(requestBody({ schema })), 502, 'INVALID_PROVIDER_RESPONSE');
    } finally {
      await server.close();
    }
  });

  test('does not alter a result that passes', async () => {
    const output = { answer: 'x', extra: { nested: [1, 'two', null] } };
    const server = await startTestServer({ provider: new MockProvider({ output }) });
    try {
      const schema = {
        ...OBJECT_SCHEMA,
        properties: { ...OBJECT_SCHEMA.properties, added: { type: 'string', default: 'd' } },
      };
      const response = await server.post(requestBody({ schema }));
      assert.deepEqual(response.body.result, output);
    } finally {
      await server.close();
    }
  });
});

describe('failure mapping over HTTP', () => {
  test('a provider failure is unavailable, and its message is withheld', async () => {
    const server = await startTestServer({
      provider: new MockProvider({ failWith: new Error('vendor said: SECRET-PROMPT-CONTENT') }),
    });
    try {
      const response = await server.post(requestBody());
      assertFailure(response, 503, 'PROVIDER_UNAVAILABLE');
      assert.doesNotMatch(JSON.stringify(response.body), /SECRET-PROMPT-CONTENT/);
      assert.doesNotMatch(server.logs(), /SECRET-PROMPT-CONTENT/);
    } finally {
      await server.close();
    }
  });

  test('a provider can supply its own safe message through ApiError', async () => {
    const server = await startTestServer({
      provider: new MockProvider({ failWith: new ApiError('PROVIDER_UNAVAILABLE', 'Overloaded.') }),
    });
    try {
      const response = await server.post(requestBody());
      assert.equal(response.body.error.message, 'Overloaded.');
    } finally {
      await server.close();
    }
  });

  test('a timeout returns 504, and the service keeps working', async () => {
    const server = await startTestServer({
      provider: new MockProvider({ latencyMs: ({ prompt }) => (prompt === 'slow' ? 5_000 : 0) }),
    });
    try {
      const slow = await server.post(requestBody({ prompt: 'slow', timeout_ms: 20 }));
      assertFailure(slow, 504, 'PROVIDER_TIMEOUT');
      assert.equal(slow.body.error.retryable, true);
      assert.equal(slow.body.error.message, 'Provider execution exceeded the configured timeout.');

      const after = await server.post(requestBody({ request_id: 'req-1' }));
      assert.equal(after.status, 200);
    } finally {
      await server.close();
    }
  });

  test('a full queue returns 429 and a duplicate id returns 409', async () => {
    const server = await startTestServer({
      config: { maxQueueSize: 1 },
      provider: new MockProvider({ latencyMs: 150 }),
    });
    try {
      const active = server.post(requestBody({ request_id: 'a' }));
      await waitFor(() => server.app.queue.stats().active === 1);
      const pending = server.post(requestBody({ request_id: 'b' }));
      await waitFor(() => server.app.queue.stats().pending === 1);

      assertFailure(
        await server.post(requestBody({ request_id: 'a' })),
        409,
        'DUPLICATE_REQUEST_ID'
      );
      assertFailure(await server.post(requestBody({ request_id: 'c' })), 429, 'QUEUE_FULL');

      assert.equal((await active).status, 200);
      assert.equal((await pending).status, 200);
    } finally {
      await server.close();
    }
  });

  test('HTTP requests run in arrival order, one at a time', async () => {
    const order = [];
    let running = 0;
    let peak = 0;
    const server = await startTestServer({
      provider: new MockProvider({
        latencyMs: 5,
        onCall: ({ prompt }) => {
          order.push(prompt);
          running += 1;
          peak = Math.max(peak, running);
          setTimeout(() => (running -= 1), 4);
        },
      }),
    });
    try {
      const responses = [];
      for (const index of [0, 1, 2, 3, 4]) {
        responses.push(server.post(requestBody({ request_id: `f${index}`, prompt: `p${index}` })));
        // Confirms arrival before sending the next, so the order is what was actually sent.
        await waitFor(
          () =>
            server.app.queue.stats().active +
              server.app.queue.stats().pending +
              server.app.queue.stats().succeeded >
            index
        );
      }
      for (const response of await Promise.all(responses)) assert.equal(response.status, 200);

      assert.deepEqual(order, ['p0', 'p1', 'p2', 'p3', 'p4']);
      assert.equal(peak, 1);
    } finally {
      await server.close();
    }
  });
});

describe('timing metadata', () => {
  test('queue wait measures queueing only, not request validation', async () => {
    const server = await startTestServer({ provider: new MockProvider({ latencyMs: 100 }) });
    try {
      // Large enough that compiling it takes measurable time on an idle queue.
      const properties = Object.fromEntries(
        Array.from({ length: 2_000 }, (_, index) => [`p${index}`, { type: 'string' }])
      );
      const schema = { type: 'object', properties };

      const first = server.post(requestBody({ request_id: 'first', schema }));
      await waitFor(() => server.app.queue.stats().active === 1);
      const second = server.post(requestBody({ request_id: 'second' }));

      const { metadata: idle } = (await first).body;
      const { metadata: queued } = (await second).body;

      assert.ok(idle.queue_wait_ms <= 2, `idle queue waited ${idle.queue_wait_ms} ms`);
      assert.ok(queued.queue_wait_ms >= 50, `queued request waited ${queued.queue_wait_ms} ms`);
      assert.ok(idle.execution_time_ms >= 90, `executed for ${idle.execution_time_ms} ms`);
      assert.ok(idle.total_time_ms >= idle.queue_wait_ms + idle.execution_time_ms - 1);
    } finally {
      await server.close();
    }
  });
});

describe('body size limit', () => {
  let server;
  before(async () => (server = await startTestServer({ config: { maxBodyBytes: 1_000 } })));
  after(() => server.close());

  test('rejects an oversized body with 413, without truncating it', async () => {
    const response = await server.post(requestBody({ prompt: 'x'.repeat(2_000) }));
    assertFailure(response, 413, 'REQUEST_TOO_LARGE');
    assert.equal(server.app.queue.stats().succeeded, 0);
  });

  test('accepts a body under the limit, with the prompt intact', async () => {
    const response = await server.post(requestBody({ prompt: 'x'.repeat(500) }));
    assert.equal(response.status, 200);
  });
});

describe('client disconnection', () => {
  test('aborts the active provider and frees the queue', async () => {
    let signalSeen;
    const server = await startTestServer({
      provider: new MockProvider({
        latencyMs: ({ prompt }) => (prompt === 'slow' ? 30_000 : 0),
        onCall: (request) => {
          if (request.prompt === 'slow') signalSeen = request.signal;
        },
      }),
    });
    try {
      const client = new AbortController();
      const abandoned = server.post(requestBody({ prompt: 'slow' }), { signal: client.signal });
      await waitFor(() => server.app.queue.stats().active === 1);

      client.abort();
      await assert.rejects(abandoned);
      await waitFor(() => server.app.queue.stats().active === 0, { label: 'queue to free' });

      assert.equal(signalSeen.aborted, true);
      assert.equal(server.app.queue.stats().cancelled, 1);

      // The same id is free again, because the disconnect released it.
      const retry = await server.post(requestBody());
      assert.equal(retry.status, 200);
    } finally {
      await server.close();
    }
  });

  test('removes a pending request, which never reaches the provider', async () => {
    const prompts = [];
    const server = await startTestServer({
      provider: new MockProvider({ latencyMs: 150, onCall: ({ prompt }) => prompts.push(prompt) }),
    });
    try {
      const active = server.post(requestBody({ request_id: 'a', prompt: 'active' }));
      await waitFor(() => server.app.queue.stats().active === 1);

      const client = new AbortController();
      const pending = server.post(requestBody({ request_id: 'b', prompt: 'pending' }), {
        signal: client.signal,
      });
      await waitFor(() => server.app.queue.stats().pending === 1);

      client.abort();
      await assert.rejects(pending);
      await waitFor(() => server.app.queue.stats().pending === 0, { label: 'pending removal' });

      assert.equal((await active).status, 200);
      assert.deepEqual(prompts, ['active']);
    } finally {
      await server.close();
    }
  });

  test('a normal response is not counted as a cancellation', async () => {
    const server = await startTestServer();
    try {
      await server.post(requestBody());
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(server.app.queue.stats().cancelled, 0);
      assert.equal(server.app.queue.stats().succeeded, 1);
    } finally {
      await server.close();
    }
  });
});

describe('error catalog', () => {
  test('every code has an HTTP error status, a retryable flag and a message', () => {
    for (const [code, [status, retryable, message]] of Object.entries(ERROR_CATALOG)) {
      assert.ok(status >= 400 && status < 600, code);
      assert.equal(typeof retryable, 'boolean', code);
      assert.ok(message.length > 0, code);
    }
  });
});
