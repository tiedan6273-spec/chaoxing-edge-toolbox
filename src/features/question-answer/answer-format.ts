import type { ApplicableAnswer, QuestionSnapshot } from './types';

/** Resolve stable option IDs against the captured question, never against another page's labels. */
export function formatApplicableAnswer(question: QuestionSnapshot, answer?: ApplicableAnswer): string {
  if (!answer) return '尚未读取当前答案';
  if (answer.code !== undefined) return answer.code || '未填写';
  const optionText = (ids: string[], options = question.options) => ids.map(id => {
    const option = options.find(value => value.id === id);
    return option ? `${option.label} · ${option.text}` : id;
  }).join('\n');
  if (answer.choices?.length) return optionText(answer.choices);
  if (answer.texts?.some(Boolean)) return answer.texts.map((value, index) => `第 ${index + 1} 空：${value || '未填写'}`).join('\n');
  if (answer.matches?.some(Boolean)) return answer.matches.map((value, index) => `第 ${index + 1} 项：${optionText([value], question.fields[index]?.options) || '未选择'}`).join('\n');
  if (answer.children?.some(value => value.choices.length)) return answer.children.map((value, index) => `子题 ${index + 1}：${optionText(value.choices, question.children.find(child => child.id === value.id)?.options) || '未选择'}`).join('\n');
  return '未填写';
}
