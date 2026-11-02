import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ApayeeClientError, ApayeeProvider } from '../examples/qatool-client/apayee-provider.js';
import { STAGE_1_SCHEMA, STAGE_2_SCHEMA } from '../examples/qatool-client/schemas.js';
import { runTwoStage } from '../examples/qatool-client/two-stage.js';
import { ApiError } from '../src/errors.js';
import { MockProvider } from '../src/providers/mock/mock.provider.js';
import { compileClientSchema } from '../src/validation/json-schema.js';
import { TEST_TOKEN, requestBody, startTestServer, waitFor } from './helpers/harness.js';

/**
 * These run the example client against a real server. QATOOL itself is not needed:
 * Apayee stays independently testable, with the contract reproduced in the adapter.
 */
describe('two-stage flow', () => {
  let server;
  const calls = [];

  before(async () => {
    server = await startTestServer({
      provider: new MockProvider({ onCall: (request) => calls.push(request) }),
    });
  });
  after(() => server.close());

  test('Stage 1 and Stage 2 succeed, and both outputs satisfy their schemas', async () => {
    calls.length = 0;
    const provider = new ApayeeProvider({ baseUrl: server.baseUrl });
    const { stage1, stage2 } = await runTwoStage(provider, { runId: 'flow-1' });

    assert.equal(compileClientSchema(STAGE_1_SCHEMA)(stage1.result).valid, true);
    assert.equal(compileClientSchema(STAGE_2_SCHEMA)(stage2.result).valid, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map((call) => call.task),
      ['understand_prd', 'generate_testcases']
    );
  });

  test('uses separate request ids', async () => {
    const provider = new ApayeeProvider({ baseUrl: server.baseUrl });
    const { stage1, stage2 } = await runTwoStage(provider, { runId: 'flow-2' });

    assert.equal(stage1.requestId, 'flow-2-stage-1');
    assert.equal(stage2.requestId, 'flow-2-stage-2');
  });

  test('the Stage 1 result is explicitly in the Stage 2 prompt the provider received', async () => {
    calls.length = 0;
    const provider = new ApayeeProvider({ baseUrl: server.baseUrl });
    const { stage1 } = await runTwoStage(provider, { runId: 'flow-3' });

    const received = calls[1].prompt;
    assert.ok(received.includes(JSON.stringify(stage1.result, null, 2)));
    assert.ok(!calls[0].prompt.includes('<understanding>'));
  });

  test('Stage 2 output reflects the handed-over Stage 1 ids', async () => {
    const provider = new ApayeeProvider({ baseUrl: server.baseUrl });
    const { stage1, stage2 } = await runTwoStage(provider, { runId: 'flow-4' });

    const stage1Ids = stage1.result.attention_areas.map((area) => area.id);
    const cited = new Set(stage2.result.testcases.flatMap((tc) => tc.attention_area_ids));
    assert.deepEqual([...cited].sort(), stage1Ids.sort());

    const flagged = stage2.result.testcases.filter((tc) => tc.review_required);
    assert.ok(flagged.length > 0);
    assert.ok(flagged.every((tc) => typeof tc.review_reason === 'string'));
  });

  test('no hidden state: without the handoff, Stage 2 knows nothing of Stage 1', async () => {
    const provider = new ApayeeProvider({ baseUrl: server.baseUrl });
    await runTwoStage(provider, { runId: 'flow-5' });

    // The same task straight after a complete run, on the same server, with no handoff.
    const { data } = await provider.generateJson({
      requestId: 'flow-5-no-handoff',
      task: 'generate_testcases',
      system: 'Generate test cases.',
      prompt: 'REQ-001 only, with no understanding attached.',
      schema: STAGE_2_SCHEMA,
    });

    assert.deepEqual(
      data.testcases.flatMap((tc) => tc.attention_area_ids),
      []
    );
    assert.ok(data.testcases.every((tc) => tc.review_required === false));
  });

  test('the same run can be repeated, because finished ids are released', async () => {
    const provider = new ApayeeProvider({ baseUrl: server.baseUrl });
    const first = await runTwoStage(provider, { runId: 'flow-6' });
    const second = await runTwoStage(provider, { runId: 'flow-6' });
    assert.deepEqual(first.stage2.result, second.stage2.result);
  });
});

describe('QATOOL generateJson contract', () => {
  test('takes { system, prompt, schema, signal } alone and returns { data, usage }', async () => {
    const server = await startTestServer();
    try {
      const provider = new ApayeeProvider({ baseUrl: server.baseUrl });
      const reply = await provider.generateJson({
        system: 'instruction',
        prompt: 'input',
        schema: requestBody().schema,
        signal: new AbortController().signal,
      });

      assert.equal(typeof reply.data.answer, 'string');
      assert.equal(typeof reply.usage, 'object');
      assert.equal(provider.name, 'Apayee');
      assert.equal(typeof provider.model, 'string');
    } finally {
      await server.close();
    }
  });

  test('accepts a schema in the shape QATOOL really sends', async () => {
    // Reproduces the awkward parts of QATOOL's generate contract: a union type with
    // an enum, long descriptions, minItems/maxItems, and a required subset.
    const schema = {
      type: 'object',
      properties: {
        project: {
          type: 'object',
          properties: {
            project_description: { type: 'string', description: 'One sentence.' },
            sit_scope: {
              type: 'array',
              minItems: 3,
              maxItems: 5,
              items: { type: 'string', description: 'One coverage area.' },
            },
          },
          required: ['project_description', 'sit_scope'],
        },
        test_cases: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              requirement_ids: { type: 'array', minItems: 1, items: { type: 'string' } },
              case_type: { type: 'string', enum: ['Positive', 'Negative', 'Edge'] },
              edge_polarity: { type: ['string', 'null'], enum: ['valid', 'invalid', null] },
            },
            required: ['requirement_ids', 'case_type'],
          },
        },
      },
      required: ['project', 'test_cases'],
    };

    const server = await startTestServer();
    try {
      const { data } = await new ApayeeProvider({ baseUrl: server.baseUrl }).generateJson({
        system: 's',
        prompt: 'p',
        schema,
      });
      assert.equal(data.project.sit_scope.length, 3);
      assert.deepEqual(data.test_cases, []);
    } finally {
      await server.close();
    }
  });

  const mappings = {
    LLM_TIMEOUT: {
      provider: { latencyMs: 5_000 },
      settings: { timeoutMs: 10 },
      apayeeCode: 'PROVIDER_TIMEOUT',
      statusCode: 504,
    },
    LLM_UNAVAILABLE: {
      provider: { failWith: new Error('down') },
      apayeeCode: 'PROVIDER_UNAVAILABLE',
      statusCode: 503,
    },
    LLM_MALFORMED_OUTPUT: {
      provider: { output: 'plain text' },
      apayeeCode: 'INVALID_PROVIDER_RESPONSE',
      statusCode: 502,
    },
  };
  for (const [code, { provider, settings, apayeeCode, statusCode }] of Object.entries(mappings)) {
    test(`maps ${apayeeCode} to ${code}`, async () => {
      const server = await startTestServer({ provider: new MockProvider(provider) });
      try {
        const client = new ApayeeProvider({ baseUrl: server.baseUrl, ...settings });
        await assert.rejects(
          client.generateJson({ system: 's', prompt: 'p', schema: {} }),
          (error) => {
            assert.ok(error instanceof ApayeeClientError);
            assert.equal(error.code, code);
            assert.equal(error.apayeeCode, apayeeCode);
            assert.equal(error.statusCode, statusCode);
            assert.equal(error.retryable, true);
            return true;
          }
        );
      } finally {
        await server.close();
      }
    });
  }

  // A provider that is switched off, signed out or unconfirmed is a state waiting does not
  // fix, so it must not read as a temporary overload (LLM_UNAVAILABLE) or be called retryable.
  const stateMappings = {
    PROVIDER_NOT_READY: { llm: 'LLM_NOT_CONFIGURED', statusCode: 503, retryable: false },
    PROVIDER_RATE_LIMITED: { llm: 'LLM_RATE_LIMITED', statusCode: 429, retryable: true },
  };
  for (const [apayeeCode, expected] of Object.entries(stateMappings)) {
    test(`maps ${apayeeCode} to ${expected.llm}, retryable=${expected.retryable}`, async () => {
      const server = await startTestServer({
        provider: new MockProvider({ failWith: new ApiError(apayeeCode) }),
      });
      try {
        const client = new ApayeeProvider({ baseUrl: server.baseUrl });
        await assert.rejects(
          client.generateJson({ system: 's', prompt: 'p', schema: {} }),
          (error) => {
            assert.ok(error instanceof ApayeeClientError);
            assert.equal(error.code, expected.llm);
            assert.equal(error.apayeeCode, apayeeCode);
            assert.equal(error.statusCode, expected.statusCode);
            assert.equal(error.retryable, expected.retryable);
            return true;
          }
        );
      } finally {
        await server.close();
      }
    });
  }

  test('maps an authentication failure, and sends the token when configured', async () => {
    const server = await startTestServer({ config: { authToken: TEST_TOKEN } });
    try {
      const args = { system: 's', prompt: 'p', schema: {} };
      await assert.rejects(
        new ApayeeProvider({ baseUrl: server.baseUrl }).generateJson(args),
        (error) => error.code === 'LLM_AUTH_FAILED' && error.statusCode === 401
      );
      const ok = await new ApayeeProvider({
        baseUrl: server.baseUrl,
        token: TEST_TOKEN,
      }).generateJson(args);
      assert.ok(ok.data);
    } finally {
      await server.close();
    }
  });

  test('an unreachable gateway reports LLM_UNAVAILABLE', async () => {
    const server = await startTestServer();
    const { baseUrl } = server;
    await server.close();

    await assert.rejects(
      new ApayeeProvider({ baseUrl }).generateJson({ system: 's', prompt: 'p', schema: {} }),
      (error) => error.code === 'LLM_UNAVAILABLE'
    );
  });

  test('aborting the caller signal cancels execution on the gateway', async () => {
    let providerSignal;
    const server = await startTestServer({
      provider: new MockProvider({
        latencyMs: 30_000,
        onCall: ({ signal }) => (providerSignal = signal),
      }),
    });
    try {
      const client = new AbortController();
      const call = new ApayeeProvider({ baseUrl: server.baseUrl }).generateJson({
        system: 's',
        prompt: 'p',
        schema: {},
        signal: client.signal,
      });
      await waitFor(() => server.app.queue.stats().active === 1);

      client.abort();
      await assert.rejects(call, (error) => error.name === 'AbortError');
      await waitFor(() => server.app.queue.stats().active === 0);
      assert.equal(providerSignal.aborted, true);
    } finally {
      await server.close();
    }
  });
});
