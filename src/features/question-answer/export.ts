import { formatApplicableAnswer } from './answer-format';
import { isCompleteApplicableAnswer } from './review';
import type { AnswerRow, AnswerSource, ApplicableAnswer, QuestionAnswerState, QuestionKind, QuestionSnapshot } from './types';

export type ResultsExportFormat = 'txt' | 'json';
export interface ResultsExportFile { name: string; mime: string; content: string; count: number }
const kindLabels: Record<QuestionKind, string> = {
  single: '单选题', multiple: '多选题', judgement: '判断题', completion: '文本填写题', line: '连线／匹配题',
  fill: '完形填空', reader: '阅读理解', program: '程序题', unsupported: '未识别题型',
};
const sourceLabels: Record<AnswerSource, string> = { bank: '言溪题库', 'bank-ai': '言溪 AI', ai: 'AI', import: '外部 AI 导入', 'local-bank': '本地题库' };
const phaseLabels: Record<AnswerRow['phase'], string> = {
  pending: '等待处理', querying: '获取中（结果未完成）', searched: '已获取参考答案（未填写）', filled: '已填写', existing: '保留页面已有答案',
  unsupported: '暂不支持', error: '处理失败', 'needs-review': '需要核对',
};

export function hasAnswerContent(answer?: ApplicableAnswer): boolean {
  return Boolean(answer?.code?.trim() || [answer?.choices, answer?.texts, answer?.matches,
    answer?.children?.flatMap(child => child.choices)].some(values => values?.some(value => value.trim())));
}

function imageAddress(value: string, index: number): string {
  try {
    const url = new URL(value);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Inline or unavailable images are represented without exporting their bytes. */ }
  return `[图片${index + 1}：内嵌图片或地址不可用，请在原页面查看]`;
}

function questionData(question: QuestionSnapshot) {
  return { number: question.number, kind: question.kind, kindLabel: kindLabels[question.kind], stem: question.stem,
    options: question.options.map(option => ({ id: option.id, label: option.label, text: option.text })),
    fields: question.fields.map(field => ({ id: field.id, options: field.options?.map(option => ({ id: option.id, label: option.label, text: option.text })) })),
    children: question.children.map(child => ({ id: child.id, stem: child.stem, options: child.options.map(option => ({ id: option.id, label: option.label, text: option.text })) })),
    images: question.images.map(imageAddress),
    ...(question.program ? { program: { language: question.program.language } } : {}),
    ...(question.textRecognition ? { recognition: { status: question.textRecognition.status, unresolvedCount: question.textRecognition.unresolvedCount } } : {}),
  };
}

function answerData(question: QuestionSnapshot, answer?: ApplicableAnswer) {
  if (!hasAnswerContent(answer)) return undefined;
  // Copy public answer fields only; no page identity, endpoint or configuration is exported.
  const value: ApplicableAnswer = {
    ...(answer?.choices ? { choices: [...answer.choices] } : {}), ...(answer?.texts ? { texts: [...answer.texts] } : {}),
    ...(answer?.matches ? { matches: [...answer.matches] } : {}), ...(answer?.code !== undefined ? { code: answer.code } : {}),
    ...(answer?.children ? { children: answer.children.map(child => ({ id: child.id, choices: [...child.choices] })) } : {}),
  };
  return { value, text: formatApplicableAnswer(question, value), complete: isCompleteApplicableAnswer(question, value) };
}

export function collectQuestionResults(state: QuestionAnswerState, title: string, now = new Date()) {
  const items = state.rows.map((row, index) => {
    const question = row.target.question;
    return { order: index + 1, question: questionData(question), status: row.phase,
      statusLabel: row.phase === 'querying' && row.resultAnswer ? '已获取答案，待填写' : phaseLabels[row.phase], message: row.message,
      source: row.source ? { id: row.source, label: sourceLabels[row.source] } : undefined,
      result: answerData(question, row.resultAnswer), pageAnswer: answerData(question, row.currentAnswer),
      ...(question.reviewData ? { platformReview: { answer: answerData(question, question.reviewData.answer),
        score: question.reviewData.score, maxScore: question.reviewData.maxScore, explanation: question.reviewData.explanation } } : {}),
      ...(!row.resultAnswer && row.text.trim() ? { unfinishedResult: { text: row.text, complete: false } } : {}),
      ...(row.review ? { review: { status: row.review.status, reason: row.review.reason, suggestion: answerData(question, row.review.suggestedAnswer) } } : {}),
    };
  });
  return { version: 1, kind: 'question-results', title: state.previewStale ? '上次页面保留的题目与答案' : title.trim() || '题目与答案',
    exportedAt: now.toISOString(), scope: 'loaded-questions', pageChanged: Boolean(state.previewStale),
    processing: state.running, total: items.length, withResults: items.filter(item => item.result).length,
    withPageAnswers: items.filter(item => item.pageAnswer).length, items };
}

function resultsText(data: ReturnType<typeof collectQuestionResults>): string {
  const parts = [data.title, `导出时间：${data.exportedAt}`, `范围：本次已加载 ${data.total} 题；已获取答案 ${data.withResults} 题，页面有答案 ${data.withPageAnswers} 题。`,
    data.pageChanged ? '页面已切换，以下为上次保留的结果。' : '仅包含当前列表已加载内容。',
    data.processing ? '导出时任务仍在处理，未完成的结果已单独标记。' : '',
    '获取的答案、页面答案和 AI 复检建议分别列出；已填写不代表平台已保存或答案正确。',
    '图片保留链接；内嵌图片需在原页面查看。', ''];
  for (const item of data.items) {
    const question = item.question;
    parts.push('='.repeat(40), `第 ${question.number || item.order} 题 · ${question.kindLabel}`, question.stem);
    for (const option of question.options) parts.push(`${option.label}. ${option.text}`);
    for (const [index, field] of question.fields.entries()) {
      parts.push(`${question.kind === 'line' ? '匹配项' : '填写位置'} ${index + 1}`);
      for (const option of field.options ?? []) parts.push(`${option.label}. ${option.text}`);
    }
    for (const [index, child] of question.children.entries()) {
      parts.push(`子题 ${index + 1}：${child.stem}`);
      for (const option of child.options) parts.push(`${option.label}. ${option.text}`);
    }
    for (const [index, image] of question.images.entries()) parts.push(`图片 ${index + 1}：${image}`);
    if (question.program) parts.push(`编程语言：${question.program.language}`);
    if (question.recognition) parts.push(`题目文字识别：${question.recognition.status}，${question.recognition.unresolvedCount} 字未识别`);
    parts.push('', `处理状态：${item.statusLabel}`, `答案来源：${item.source?.label ?? '未获取／页面已有内容'}`,
      `获取的答案：${item.result ? `\n${item.result.text}` : '尚未获取可用答案'}`,
      `页面答案${item.pageAnswer && !item.pageAnswer.complete ? '（部分）' : ''}：${item.pageAnswer ? `\n${item.pageAnswer.text}` : '未读取或未填写'}`);
    if (item.message) parts.push(`处理说明：${item.message}`);
    if (item.platformReview) parts.push(`平台回看：我的答案 ${item.platformReview.answer?.text ?? '未读取'}（不等同于标准答案）`,
      `平台得分：${item.platformReview.score || '未提供'} / ${item.platformReview.maxScore || '未提供'}`,
      `平台解析：${item.platformReview.explanation || '未提供'}`);
    if (item.unfinishedResult) parts.push('获取原文（未形成完整可用答案，需核对）：', item.unfinishedResult.text);
    if (item.review) parts.push('AI 复检（建议，待核对）：', item.review.reason,
      ...(item.review.suggestion ? [item.review.suggestion.text] : []));
    parts.push('');
  }
  return parts.join('\r\n').replace(/(?<!\r)\n/g, '\r\n');
}

/** Snapshot-only export. Does not scan pages, request a model, fill controls or mutate a queue. */
export function createQuestionResultsFile(state: QuestionAnswerState, format: ResultsExportFormat, title: string, now = new Date()): ResultsExportFile {
  if (!state.rows.length) throw new Error('还没有题目，请先识别当前页。');
  const data = collectQuestionResults(state, title, now);
  const safeTitle = data.title.replace(/[<>:"/\\|?*]/g, ' ').replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).replace(/[. ]+$/, '') || '当前题目';
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return { name: `题目与答案-${safeTitle}-${stamp}.${format}`, count: data.total,
    mime: format === 'txt' ? 'text/plain;charset=utf-8' : 'application/json;charset=utf-8',
    content: format === 'txt' ? `\ufeff${resultsText(data)}` : JSON.stringify(data, null, 2) + '\n' };
}
