import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { ApiError } from '../errors.js';

/**
 * Compiles a schema supplied by a client, and judges provider output against it.
 *
 * Client schemas are data arriving over the network that get turned into code,
 * so each decision here is deliberate:
 *
 *   One Ajv instance per schema. QATOOL builds schemas per call, so a shared
 *   instance would grow forever, and a repeated $id would collide across requests.
 *
 *   strict: false. Real schemas carry union types and vendor annotations such as
 *   `propertyOrdering`; annotations are legal JSON Schema and are ignored.
 *
 *   No coercion, no defaults, no removal. Validation only ever reads the result,
 *   so what is validated is exactly what the client receives.
 *
 *   pattern and patternProperties are refused. Validation is synchronous, so one
 *   catastrophic regex would freeze the event loop where no timeout can reach it.
 *
 *   No loadSchema. An external $ref fails compilation; nothing is ever fetched.
 *
 *   allErrors: true, despite Ajv's caution about it for attacker-controlled data.
 *   Without it Ajv nests generated code per property, and a legitimate flat schema
 *   of about 1,000 properties overflows the stack during compilation. The data being
 *   validated comes from the operator's provider, and reported errors are capped.
 */
const MAX_SCHEMA_DEPTH = 64;
const MAX_REPORTED_ERRORS = 20;

const DRAFT_07 = /^https?:\/\/json-schema\.org\/draft-07\/schema#?$/;
const DRAFT_2020 = /^https:\/\/json-schema\.org\/draft\/2020-12\/schema#?$/;

/** @returns {typeof Ajv} */
function dialectFor(schema) {
  const declared = schema.$schema;
  if (declared === undefined || DRAFT_07.test(declared)) return Ajv;
  if (DRAFT_2020.test(declared)) return Ajv2020;
  throw new ApiError(
    'INVALID_SCHEMA',
    'Unsupported $schema. Supported dialects: draft-07 (the default) and draft 2020-12.'
  );
}

/** Iterative, because the input is exactly what could overflow a recursive walk. */
function exceedsDepth(root, limit) {
  const stack = [[root, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    if (depth > limit) return true;
    for (const child of Object.values(node)) stack.push([child, depth + 1]);
  }
  return false;
}

/**
 * @param {object} schema
 * @param {object} [limits]
 * @param {number} [limits.maxBytes]
 * @returns {(data: unknown) => {valid: boolean, errors: {path: string, message: string}[]}}
 * @throws {ApiError} INVALID_SCHEMA
 */
export function compileClientSchema(schema, { maxBytes = Infinity } = {}) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new ApiError('INVALID_SCHEMA', 'schema must be a JSON Schema object.');
  }
  if (exceedsDepth(schema, MAX_SCHEMA_DEPTH)) {
    throw new ApiError(
      'INVALID_SCHEMA',
      `schema is nested deeper than ${MAX_SCHEMA_DEPTH} levels.`
    );
  }
  if (Buffer.byteLength(JSON.stringify(schema)) > maxBytes) {
    throw new ApiError('INVALID_SCHEMA', `schema exceeds the ${maxBytes} byte limit.`);
  }
  assertStructuredRoot(schema);

  const Dialect = dialectFor(schema);
  let refusePatterns = false;
  const regExp = (source, flags) => {
    if (refusePatterns) {
      throw new ApiError(
        'INVALID_SCHEMA',
        'pattern and patternProperties are not supported in client schemas.'
      );
    }
    return new RegExp(source, flags);
  };
  regExp.code = 'new RegExp';

  try {
    const ajv = new Dialect({ strict: false, allErrors: true, logger: false, code: { regExp } });
    addFormats(ajv);

    // Ajv's own meta-schemas use pattern, and compile lazily on first use. Checking
    // the schema first gets them compiled before the refusal is switched on.
    if (!ajv.validateSchema(schema)) {
      const reason = ajv.errorsText(ajv.errors, { dataVar: 'schema' });
      throw new ApiError('INVALID_SCHEMA', `schema is invalid: ${reason}`);
    }
    refusePatterns = true;

    const validate = ajv.compile(schema);

    // An async validator returns a promise, which would read as "valid".
    if (validate.$async) {
      throw new ApiError('INVALID_SCHEMA', '$async schemas are not supported.');
    }

    return (data) => {
      const valid = validate(data);
      return {
        valid,
        errors: (validate.errors ?? []).slice(0, MAX_REPORTED_ERRORS).map((error) => ({
          path: error.instancePath || '/',
          message: error.message ?? 'is invalid',
        })),
      };
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // Ajv names what is wrong (an unresolved $ref, a bad keyword) without quoting data.
    throw new ApiError('INVALID_SCHEMA', `schema could not be compiled: ${error.message}`);
  }
}

/**
 * Providers must return structured JSON, so a schema may not ask for a bare string
 * or number. It also means a Markdown-wrapped reply can never pass as a "string".
 */
function assertStructuredRoot(schema) {
  if (schema.type === undefined) return;

  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.includes('object') && !types.includes('array')) {
    throw new ApiError('INVALID_SCHEMA', 'schema root must describe an object or an array.');
  }
}
