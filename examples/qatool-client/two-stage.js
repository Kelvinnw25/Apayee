import { Ajv } from 'ajv';
import { STAGE_1_SCHEMA, STAGE_2_SCHEMA } from './schemas.js';

/**
 * A simulation of the integration pattern, not an implementation of QATOOL's pipeline.
 *
 * The client owns orchestration and context. Stage 2 knows Stage 1's result only
 * because it is written into the Stage 2 prompt here; Apayee keeps nothing between
 * the two calls. Each result is also validated by the client, as QATOOL validates
 * replies with its own contract rather than trusting the provider.
 */
const SAMPLE_PRD = `Sample PRD (illustrative only)
REQ-001 The system shall accept a refund request for a settled payment.
REQ-002 The system shall reject a refund request above the settled amount.`;

const ajv = new Ajv({ strict: false });
const validateStage1 = ajv.compile(STAGE_1_SCHEMA);
const validateStage2 = ajv.compile(STAGE_2_SCHEMA);

function assertValid(validate, data, stage) {
  if (!validate(data)) {
    throw new Error(`${stage} result failed client validation: ${ajv.errorsText(validate.errors)}`);
  }
}

/**
 * @param {import('./apayee-provider.js').ApayeeProvider} provider
 * @param {object} [options]
 * @param {string} [options.runId]
 * @param {string} [options.prd]
 */
export async function runTwoStage(provider, { runId = 'demo-run', prd = SAMPLE_PRD, signal } = {}) {
  const stage1RequestId = `${runId}-stage-1`;
  const stage2RequestId = `${runId}-stage-2`;

  const stage1 = await provider.generateJson({
    requestId: stage1RequestId,
    task: 'understand_prd',
    system: 'Understand this PRD and return the requested structure.',
    prompt: `<prd>\n${prd}\n</prd>`,
    schema: STAGE_1_SCHEMA,
    signal,
  });
  assertValid(validateStage1, stage1.data, 'Stage 1');

  const stage2Prompt = [
    `<prd>\n${prd}\n</prd>`,
    `<understanding>\n${JSON.stringify(stage1.data, null, 2)}\n</understanding>`,
  ].join('\n\n');

  const stage2 = await provider.generateJson({
    requestId: stage2RequestId,
    task: 'generate_testcases',
    system: 'Generate test cases from the PRD and the understanding provided.',
    prompt: stage2Prompt,
    schema: STAGE_2_SCHEMA,
    signal,
  });
  assertValid(validateStage2, stage2.data, 'Stage 2');

  return {
    stage1: { requestId: stage1RequestId, result: stage1.data, metadata: stage1.metadata },
    stage2: { requestId: stage2RequestId, result: stage2.data, metadata: stage2.metadata },
    stage2Prompt,
  };
}
