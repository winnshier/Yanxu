import { describe, expect, it } from 'vitest';
import type { TaskPlan } from '@yanxu/contracts';
import { buildPlanQuestionFormAnswers, serializePlanQuestionAnswers } from '../lib/plan-questions.js';

const questions: TaskPlan['questions'] = [{
  id: 'q_format',
  question: '导出格式如何选择？',
  options: [{
    id: 'option_csv',
    label: 'CSV',
    description: '适合表格处理。',
    value: '使用 CSV 格式交付。',
    recommended: true,
  }, {
    id: 'option_json',
    label: 'JSON',
    description: '适合程序消费。',
    value: '使用 JSON 格式交付。',
    recommended: false,
  }],
  answer: null,
}];

describe('plan question decisions', () => {
  it('serializes a selected coordinator option as its complete answer', () => {
    expect(serializePlanQuestionAnswers(questions, {
      q_format: { optionId: 'option_csv' },
    })).toEqual({ q_format: '使用 CSV 格式交付。' });
  });

  it('preserves and trims a custom answer', () => {
    expect(serializePlanQuestionAnswers(questions, {
      q_format: { optionId: 'custom', custom: '  同时交付 CSV 和 JSON。  ' },
    })).toEqual({ q_format: '同时交付 CSV 和 JSON。' });
  });

  it('restores a previously selected coordinator option', () => {
    expect(buildPlanQuestionFormAnswers([{
      ...questions[0]!,
      answer: '使用 JSON 格式交付。',
    }])).toEqual({
      q_format: { optionId: 'option_json', custom: '' },
    });
  });
});
