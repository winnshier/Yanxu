import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';

export type StructuredOutputValidation<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

export interface StructuredOutputValidator<T> {
  parseAndValidate(raw: string): StructuredOutputValidation<T>;
}

export function createStructuredOutputValidator<T>(schema: Record<string, unknown>): StructuredOutputValidator<T> {
  const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
  const validate = ajv.compile(schema) as ValidateFunction<unknown>;
  return {
    parseAndValidate(raw: string): StructuredOutputValidation<T> {
      let value: unknown;
      try {
        value = parseJsonResponse(raw);
      } catch (error) {
        return { ok: false, errors: [error instanceof Error ? error.message : '响应不是有效 JSON。'] };
      }
      if (validate(value)) return { ok: true, value: value as T };
      return { ok: false, errors: formatValidationErrors(validate.errors) };
    },
  };
}

export function parseJsonResponse(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('模型返回了空响应。');

  const candidates = [trimmed, ...extractCodeBlocks(trimmed), ...extractBalancedJson(trimmed)];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = candidate.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    try {
      return JSON.parse(normalized) as unknown;
    } catch {
      // Try the next candidate. Models occasionally add a short explanation
      // or wrap the JSON in a Markdown fence even when asked not to.
    }
  }
  throw new Error('模型响应中未找到可解析的 JSON 对象。');
}

export function isStructuredOutputCompatibilityError(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  const missingStructuredResult = text.includes('model did not produce structured output')
    || text.includes('opencode did not return structured output')
    || text.includes('structuredoutputerror');
  if (missingStructuredResult) return true;
  if (!text.includes('tool_choice') && !text.includes('tool choice')) return false;
  const rejectsForcedChoice = text.includes('required') || text.includes('object') || text.includes('forced');
  const unsupported = text.includes('not support') || text.includes('unsupported') || text.includes('invalid');
  return rejectsForcedChoice && unsupported;
}

function extractCodeBlocks(value: string): string[] {
  const blocks: string[] = [];
  const expression = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of value.matchAll(expression)) {
    if (match[1]) blocks.push(match[1]);
  }
  return blocks;
}

function extractBalancedJson(value: string): string[] {
  const candidates: string[] = [];
  for (let start = 0; start < value.length; start += 1) {
    const first = value[start];
    if (first !== '{' && first !== '[') continue;
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
      const character = value[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === '{') stack.push('}');
      else if (character === '[') stack.push(']');
      else if (character === '}' || character === ']') {
        if (stack.pop() !== character) break;
        if (stack.length === 0) {
          candidates.push(value.slice(start, index + 1));
          start = index;
          break;
        }
      }
    }
  }
  return candidates;
}

function formatValidationErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors?.length) return ['响应未通过 JSON Schema 校验。'];
  return errors.slice(0, 20).map((error) => {
    const path = error.instancePath || '/';
    return `${path} ${error.message ?? '不符合约束'}`;
  });
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const details = error.cause === undefined ? '' : ` ${errorText(error.cause)}`;
    return `${error.name}: ${error.message}${details}`;
  }
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
