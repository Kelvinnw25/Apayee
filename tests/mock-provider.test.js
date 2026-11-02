import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MockProvider } from '../src/providers/mock/mock.provider.js';
import { synthesize } from '../src/providers/mock/synthesize.js';
import { Provider } from '../src/providers/provider.js';
import { compileClientSchema } from '../src/validation/json-schema.js';
import { STAGE_1_SCHEMA, STAGE_2_SCHEMA } from '../examples/qatool-client/schemas.js';

const generate = (provider, overrides) =>
  provider.generate({ system: 's', prompt: 'p', schema: {}, task: 'generic', ...overrides });

describe('MockProvider', () => {
  test('supports the documented tasks only', () => {
    const provider = new MockProvider();
    for (const task of ['understand_prd', 'generate_testcases', 'generic']) {
      assert.equal(provider.supportsTask(task), true);
    }
    assert.equal(provider.supportsTask('other'), false);
  });

  test('understand_prd returns every Stage 1 field, valid against the schema', async () => {
    const { data } = await generate(new MockProvider(), {
      task: 'understand_prd',
      schema: STAGE_1_SCHEMA,
    });
    assert.deepEqual(Object.keys(data).sort(), [...STAGE_1_SCHEMA.required].sort());
    assert.equal(compileClientSchema(STAGE_1_SCHEMA)(data).valid, true);
  });

  test('generate_testcases returns every testcase field, valid against the schema', async () => {
    const { data } = await generate(new MockProvider(), {
      task: 'generate_testcases',
      schema: STAGE_2_SCHEMA,
      prompt: 'REQ-001 and AA-001',
    });
    assert.equal(compileClientSchema(STAGE_2_SCHEMA)(data).valid, true);
    for (const field of STAGE_2_SCHEMA.properties.testcases.items.required) {
      assert.ok(field in data.testcases[0], field);
    }
  });

  test('is deterministic, and one answer cannot be mutated into the next', async () => {
    const provider = new MockProvider();
    const request = { task: 'understand_prd', schema: STAGE_1_SCHEMA };

    const first = await generate(provider, request);
    const snapshot = structuredClone(first.data);
    first.data.sit_scope.push('tampered');

    const second = await generate(provider, request);
    assert.deepEqual(second.data, snapshot);
  });

  test('falls back to the schema when a fixture does not fit it', async () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['something_else'],
      properties: { something_else: { type: 'string' } },
    };
    for (const task of ['understand_prd', 'generate_testcases', 'generic']) {
      const { data } = await generate(new MockProvider(), { task, schema });
      assert.equal(compileClientSchema(schema)(data).valid, true, task);
    }
  });

  test('test controls: latency honours abort, and can be made not to', async () => {
    const controller = new AbortController();
    const pending = generate(new MockProvider({ latencyMs: 30_000 }), {
      signal: controller.signal,
    });
    controller.abort(new Error('stop'));
    await assert.rejects(pending);

    const stubborn = new AbortController();
    const started = Date.now();
    const finished = generate(new MockProvider({ latencyMs: 30, ignoreAbort: true }), {
      signal: stubborn.signal,
    });
    stubborn.abort();
    await finished;
    assert.ok(Date.now() - started >= 25);
  });

  test('test controls: failure and malformed output', async () => {
    await assert.rejects(generate(new MockProvider({ failWith: new Error('down') })), /down/);
    const { data } = await generate(new MockProvider({ output: 'not structured' }));
    assert.equal(data, 'not structured');
  });

  test('default construction has no test behaviour', () => {
    assert.deepEqual(new MockProvider().testOptions, {});
  });

  test('does not start work when already aborted', async () => {
    await assert.rejects(generate(new MockProvider(), { signal: AbortSignal.abort() }));
  });
});

describe('synthesize', () => {
  const schemas = {
    'scalars of each type': {
      type: 'object',
      required: ['s', 'i', 'n', 'b', 'x'],
      properties: {
        s: { type: 'string', minLength: 40 },
        i: { type: 'integer', minimum: 7 },
        n: { type: 'number', exclusiveMinimum: 1 },
        b: { type: 'boolean' },
        x: { type: 'null' },
      },
    },
    'a negative maximum': {
      type: 'object',
      required: ['a', 'b'],
      properties: {
        a: { type: 'integer', maximum: -5 },
        b: { type: 'integer', exclusiveMaximum: 0 },
      },
    },
    'minItems and nesting': {
      type: 'object',
      required: ['list'],
      properties: {
        list: {
          type: 'array',
          minItems: 3,
          items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        },
      },
    },
    'enum, const and union types': {
      type: 'object',
      required: ['e', 'c', 'u', 'nullableEnum'],
      properties: {
        e: { type: 'string', enum: ['one', 'two'] },
        c: { const: 42 },
        u: { type: ['string', 'null'] },
        nullableEnum: { type: ['string', 'null'], enum: [null, 'valid'] },
      },
    },
    'references, anyOf and allOf': {
      type: 'object',
      required: ['r', 'a', 'o'],
      properties: {
        r: { $ref: '#/definitions/thing' },
        a: { anyOf: [{ type: 'integer' }, { type: 'string' }] },
        o: {
          allOf: [{ type: 'object', required: ['x'], properties: { x: { type: 'string' } } }],
        },
      },
      definitions: { thing: { type: 'string', maxLength: 3 } },
    },
    'optional properties are left out': {
      type: 'object',
      additionalProperties: false,
      properties: { optional: { type: 'string' } },
    },
  };

  for (const [name, schema] of Object.entries(schemas)) {
    test(`satisfies ${name}`, () => {
      const data = synthesize(schema);
      const { valid, errors } = compileClientSchema(schema)(data);
      assert.equal(valid, true, JSON.stringify({ data, errors }));
    });
  }

  test('terminates on a self-referencing schema', () => {
    const schema = {
      type: 'object',
      required: ['next'],
      properties: { next: { $ref: '#' } },
    };
    assert.doesNotThrow(() => synthesize(schema));
  });
});

describe('Provider base class', () => {
  test('requires generate to be implemented', async () => {
    await assert.rejects(new Provider({ name: 'x' }).generate({}), /must implement generate/);
  });

  test('accepts any task unless a provider narrows it', () => {
    assert.equal(new Provider({ name: 'x' }).supportsTask('anything'), true);
  });
});
