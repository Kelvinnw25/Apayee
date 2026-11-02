/**
 * Builds a minimal value that satisfies a JSON Schema, deterministically.
 *
 * This lets the mock answer any client schema, not only the shapes it has fixtures
 * for. It handles the keywords structured-output schemas actually use and makes no
 * attempt to be complete. If it cannot satisfy a schema the output fails validation
 * and the client gets INVALID_PROVIDER_RESPONSE, which is an honest failure.
 */
const MAX_DEPTH = 32;

export function synthesize(rootSchema) {
  return build(rootSchema, rootSchema, 'value', 0);
}

function build(schema, root, label, depth) {
  if (depth > MAX_DEPTH || schema === null || typeof schema !== 'object') return null;

  if (schema.$ref) return build(resolveRef(schema.$ref, root), root, label, depth + 1);
  if ('const' in schema) return schema.const;
  if (schema.enum?.length > 0) return schema.enum.find((value) => value !== null) ?? null;

  const branch = schema.anyOf?.[0] ?? schema.oneOf?.[0];
  if (branch)
    return build(
      { ...schema, anyOf: undefined, oneOf: undefined, ...branch },
      root,
      label,
      depth + 1
    );

  if (schema.allOf?.length > 0) {
    const merged = Object.assign({}, schema, ...schema.allOf, { allOf: undefined });
    return build(merged, root, label, depth + 1);
  }

  switch (concreteType(schema)) {
    case 'object':
      return buildObject(schema, root, depth);
    case 'array':
      return buildArray(schema, root, label, depth);
    case 'string':
      return buildString(schema, label);
    case 'integer':
    case 'number':
      return buildNumber(schema);
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      return {};
  }
}

function concreteType(schema) {
  if (Array.isArray(schema.type)) return schema.type.find((type) => type !== 'null') ?? 'null';
  if (schema.type) return schema.type;
  if (schema.properties) return 'object';
  if (schema.items) return 'array';
  return undefined;
}

function resolveRef(ref, root) {
  if (!ref.startsWith('#')) return null;

  let node = root;
  for (const part of ref.slice(1).split('/').filter(Boolean)) {
    node = node?.[part.replaceAll('~1', '/').replaceAll('~0', '~')];
  }
  return node ?? null;
}

function buildObject(schema, root, depth) {
  const output = {};
  for (const key of schema.required ?? []) {
    output[key] = build(schema.properties?.[key] ?? {}, root, key, depth + 1);
  }
  return output;
}

function buildArray(schema, root, label, depth) {
  const count = schema.minItems ?? 0;
  return Array.from({ length: count }, (_, index) =>
    build(schema.items ?? {}, root, `${label}-${index + 1}`, depth + 1)
  );
}

function buildString(schema, label) {
  let text = `mock-${label}`;
  if (schema.minLength) text = text.padEnd(schema.minLength, '-');
  if (schema.maxLength !== undefined) text = text.slice(0, schema.maxLength);
  return text;
}

function buildNumber(schema) {
  if (schema.minimum !== undefined) return schema.minimum;
  if (schema.exclusiveMinimum !== undefined) return schema.exclusiveMinimum + 1;
  if (schema.maximum !== undefined && schema.maximum < 0) return schema.maximum;
  if (schema.exclusiveMaximum !== undefined && schema.exclusiveMaximum <= 0) {
    return schema.exclusiveMaximum - 1;
  }
  return 0;
}
