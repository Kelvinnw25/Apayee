/**
 * The schemas a client owns and sends with each request. Apayee has no knowledge
 * of these shapes beyond validating the provider's output against them.
 */
export const STAGE_1_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'project_description',
    'qa_guidance',
    'sit_scope',
    'project_background',
    'context_understanding',
    'attention_areas',
  ],
  properties: {
    project_description: { type: 'string', minLength: 1 },
    qa_guidance: { type: 'string', minLength: 1 },
    sit_scope: { type: 'array', minItems: 1, items: { type: 'string' } },
    project_background: { type: 'string', minLength: 1 },
    context_understanding: { type: 'string', minLength: 1 },
    attention_areas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'description'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
        },
      },
    },
  },
};

export const STAGE_2_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['testcases'],
  properties: {
    testcases: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'testcase_id',
          'scenario',
          'steps',
          'expected_result',
          'requirement_ref',
          'review_required',
          'review_reason',
          'attention_area_ids',
        ],
        properties: {
          testcase_id: { type: 'string' },
          scenario: { type: 'string' },
          steps: { type: 'array', minItems: 1, items: { type: 'string' } },
          expected_result: { type: 'string' },
          requirement_ref: { type: 'string' },
          review_required: { type: 'boolean' },
          review_reason: { type: ['string', 'null'] },
          attention_area_ids: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};
