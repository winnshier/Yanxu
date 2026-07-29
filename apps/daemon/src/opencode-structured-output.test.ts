import { describe, expect, it } from 'vitest';
import {
  createStructuredOutputValidator,
  isStructuredOutputCompatibilityError,
  parseJsonResponse,
} from '@yanxu/executors';

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    evidence: { type: 'string' },
  },
  required: ['ok', 'evidence'],
};

describe('OpenCode structured output compatibility', () => {
  it('extracts JSON from fenced or explanatory model responses', () => {
    expect(parseJsonResponse('结果如下：\n```json\n{"ok":true,"evidence":"done"}\n```')).toEqual({
      ok: true,
      evidence: 'done',
    });
  });

  it('validates parsed JSON against the local schema', () => {
    const validator = createStructuredOutputValidator<{ ok: boolean; evidence: string }>(schema);
    expect(validator.parseAndValidate('{"ok":true,"evidence":"done"}')).toEqual({
      ok: true,
      value: { ok: true, evidence: 'done' },
    });
    const invalid = validator.parseAndValidate('{"ok":"yes","extra":1}');
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.errors.join(' ')).toContain('additional properties');
      expect(invalid.errors.join(' ')).toContain("must have required property 'evidence'");
      expect(invalid.errors.join(' ')).toContain('must be boolean');
    }
  });

  it('falls back for forced tool-choice and missing structured-result compatibility errors', () => {
    expect(isStructuredOutputCompatibilityError(
      new Error('The tool_choice parameter does not support being set to required or object in thinking mode'),
    )).toBe(true);
    expect(isStructuredOutputCompatibilityError(
      new Error('Model did not produce structured output'),
    )).toBe(true);
    expect(isStructuredOutputCompatibilityError({
      name: 'StructuredOutputError',
      data: { message: 'Schema tool was not called.' },
    })).toBe(true);
    expect(isStructuredOutputCompatibilityError(new Error('API key is invalid'))).toBe(false);
    expect(isStructuredOutputCompatibilityError(new Error('Model context window exceeded'))).toBe(false);
  });
});
