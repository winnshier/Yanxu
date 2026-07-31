import { describe, expect, it } from 'vitest';
import { selectNewCompletedPromptResult, selectNewToolAttempt } from '@yanxu/executors';

describe('OpenCode asynchronous prompt completion', () => {
  it('selects only a newly completed assistant message', () => {
    const result = selectNewCompletedPromptResult([
      {
        info: { id: 'old', role: 'assistant', time: { completed: 1 }, structured: { value: 'old' } },
        parts: [],
      },
      {
        info: { id: 'user', role: 'user', time: { completed: 2 } },
        parts: [],
      },
      {
        info: { id: 'running', role: 'assistant', time: {} },
        parts: [{ type: 'text', text: 'partial' }],
      },
      {
        info: { id: 'done', role: 'assistant', time: { completed: 3 }, structured: { value: 'new' } },
        parts: [],
      },
    ], new Set(['old']));

    expect(result?.info.id).toBe('done');
    expect(result?.info.structured).toEqual({ value: 'new' });
  });

  it('returns a completed assistant error so the caller can classify it', () => {
    const result = selectNewCompletedPromptResult([
      {
        info: { id: 'failed', role: 'assistant', error: { name: 'APIError', data: { message: 'failed' } } },
        parts: [],
      },
    ], new Set());

    expect(result?.info.error?.name).toBe('APIError');
  });

  it('does not treat a completed tool-loop message as final while the session is busy', () => {
    const result = selectNewCompletedPromptResult([
      {
        info: { id: 'tool-loop', role: 'assistant', time: { completed: 1 } },
        parts: [{ type: 'text', text: '工作区检查完成，继续写文件。' }],
      },
      {
        info: { id: 'next-turn', role: 'assistant', time: {} },
        parts: [],
      },
    ], new Set(), 'busy');

    expect(result).toBeUndefined();
  });

  it('selects the latest completed message regardless of API array order', () => {
    const newestFirst = selectNewCompletedPromptResult([
      {
        info: { id: 'final', role: 'assistant', time: { created: 30, completed: 40 } },
        parts: [{ type: 'text', text: '{"status":"succeeded"}' }],
      },
      {
        info: { id: 'tool-loop', role: 'assistant', time: { created: 10, completed: 20 } },
        parts: [{ type: 'text', text: '' }],
      },
    ], new Set(), 'idle');

    const oldestFirst = selectNewCompletedPromptResult([
      {
        info: { id: 'tool-loop', role: 'assistant', time: { created: 10, completed: 20 } },
        parts: [{ type: 'text', text: '' }],
      },
      {
        info: { id: 'final', role: 'assistant', time: { created: 30, completed: 40 } },
        parts: [{ type: 'text', text: '{"status":"succeeded"}' }],
      },
    ], new Set(), 'idle');

    expect(newestFirst?.info.id).toBe('final');
    expect(oldestFirst?.info.id).toBe('final');
  });

  it('detects a pending tool call in a new assistant message', () => {
    const attempt = selectNewToolAttempt([
      {
        info: { id: 'old', role: 'assistant', time: { completed: 1 } },
        parts: [{ type: 'tool', tool: 'read', state: { status: 'completed' } }],
      },
      {
        info: { id: 'new', role: 'assistant', time: {} },
        parts: [{ type: 'tool', tool: 'bash', state: { status: 'pending' } }],
      },
    ], new Set(['old']));

    expect(attempt).toEqual({
      messageId: 'new',
      tool: 'bash',
      status: 'pending',
    });
  });
});
