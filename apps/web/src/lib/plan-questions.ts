import type { AnswerPlanInput, TaskPlan } from '@yanxu/contracts';

export interface PlanQuestionFormAnswer {
  optionId?: string;
  custom?: string;
}

export function buildPlanQuestionFormAnswers(
  questions: TaskPlan['questions'],
): Record<string, PlanQuestionFormAnswer> {
  return Object.fromEntries(questions.map((question) => {
    const options = question.options ?? [];
    const selectedOption = options.find((option) => option.value === question.answer);
    return [question.id, selectedOption
      ? { optionId: selectedOption.id, custom: '' }
      : question.answer || options.length === 0
        ? { optionId: 'custom', custom: question.answer ?? '' }
        : { custom: '' }];
  }));
}

export function serializePlanQuestionAnswers(
  questions: TaskPlan['questions'],
  answers: Record<string, PlanQuestionFormAnswer> | undefined,
): AnswerPlanInput['answers'] {
  return Object.fromEntries(questions.map((question) => {
    const answer = answers?.[question.id];
    const selectedOption = (question.options ?? []).find((option) => option.id === answer?.optionId);
    return [
      question.id,
      answer?.optionId === 'custom'
        ? answer.custom?.trim() ?? ''
        : selectedOption?.value ?? '',
    ];
  }));
}
