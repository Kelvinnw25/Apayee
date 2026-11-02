import { ApayeeProvider } from './apayee-provider.js';
import { runTwoStage } from './two-stage.js';

/** Runs the two-stage simulation against an already running Apayee. */
const host = process.env.APAYEE_HOST || '127.0.0.1';
const port = process.env.APAYEE_PORT || '4100';
const baseUrl = process.env.APAYEE_URL ?? `http://${host}:${port}`;

const provider = new ApayeeProvider({ baseUrl, token: process.env.APAYEE_AUTH_TOKEN || undefined });

try {
  const { stage1, stage2, stage2Prompt } = await runTwoStage(provider, {
    runId: `demo-${Date.now()}`,
  });

  const attentionIds = stage1.result.attention_areas.map((area) => area.id);
  const cited = new Set(stage2.result.testcases.flatMap((tc) => tc.attention_area_ids));

  console.log(`Apayee: ${baseUrl}`);
  console.log(`Stage 1  ${stage1.requestId}`);
  console.log(`  validated; ${attentionIds.length} attention areas: ${attentionIds.join(', ')}`);
  console.log(
    `  queue ${stage1.metadata.queue_wait_ms} ms, execution ${stage1.metadata.execution_time_ms} ms`
  );
  console.log(`Stage 2  ${stage2.requestId}`);
  console.log(`  validated; ${stage2.result.testcases.length} test cases`);
  console.log(
    `  queue ${stage2.metadata.queue_wait_ms} ms, execution ${stage2.metadata.execution_time_ms} ms`
  );
  console.log('Handoff');
  console.log(`  Stage 1 result in Stage 2 prompt: ${stage2Prompt.includes('<understanding>')}`);
  console.log(`  Stage 2 cites attention areas: ${[...cited].join(', ') || 'none'}`);
  console.log(`  Separate request ids: ${stage1.requestId !== stage2.requestId}`);
} catch (error) {
  console.error(`Failed: ${error.code ?? error.name}: ${error.message}`);
  if (error.code === 'LLM_UNAVAILABLE')
    console.error('Is Apayee running? Start it with: npm start');
  process.exitCode = 1;
}
