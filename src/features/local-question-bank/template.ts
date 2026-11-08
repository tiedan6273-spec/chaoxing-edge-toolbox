import { sanitizeBankEntry } from '../answer-exchange/protocol';
import type { BankEntry } from '../answer-exchange/types';
import { normalizeAnswer } from '../question-answer/normalize';
import type { ApplicableAnswer, QuestionSnapshot } from '../question-answer/types';
import { localBankEntryIdentity, localQuestionContentKey } from './matching';
import { LOCAL_QUESTION_BANK_LIMIT } from './types';
import type { BankDraft, DraftEntry } from './library-types';
import { judgementMeaning } from './semantic';

export const BANK_TEMPLATE_VERSION = 'CXQB-1';
const labels = ['编号', '题型', '空数', '题干', '选项', '答案', '解析'];
const kindMap = { 单选: 'single', 多选: 'multiple', 判断: 'judgement', 填空: 'completion', 简答: 'completion' } as const;
const escape = (text: string) => text.replace(/\\/g, '\\\\').replace(/^(?=【(?:题目|结束)】\s*$|(?:编号|题型|空数|题干|选项|答案|解析)[：:])/gm, '\\');
const unescape = (text: string) => text.replace(/^\\(?=【(?:题目|结束)】|(?:编号|题型|空数|题干|选项|答案|解析)[：:])/gm, '').replace(/\\\\/g, '\\');

function parseOptions(value: string): QuestionSnapshot['options'] {
  const result: QuestionSnapshot['options'] = [];
  for (const line of value.split('\n')) {
    if (!line.trim()) continue;
    const match = line.match(/^([A-Z])[.)]\s+(.+)$/);
    if (match) result.push({ id: `option-${match[1]}`, label: match[1], text: unescape(match[2]) });
    else if (result.length) result.at(-1)!.text += `\n${unescape(line)}`;
    else throw new Error('选项应以 A. 内容、B. 内容的形式书写。');
  }
  if (result.length < 2 || new Set(result.map(o => o.label)).size !== result.length
    || new Set(result.map(o => o.text.normalize('NFC').replace(/\s+/g, ' ').trim())).size !== result.length) {
    throw new Error('需要至少两个不同且字母唯一的选项。');
  }
  return result;
}

function parseBlock(lines: string[], position: string): DraftEntry {
  const fields = new Map<string, string>();
  let current = ''; let previous = -1;
  for (const line of lines) {
    const match = line.match(/^(编号|题型|空数|题干|选项|答案|解析)[：:]\s*(.*)$/);
    if (match) {
      const order = labels.indexOf(match[1]);
      if (order <= previous || fields.has(match[1])) throw new Error(`字段“${match[1]}”重复或顺序不正确。`);
      current = match[1]; previous = order; fields.set(current, match[2]);
    } else if (current) fields.set(current, `${fields.get(current)}\n${line}`);
    else if (line.trim()) throw new Error('题块必须先写“编号”。');
  }
  const get = (name: string) => unescape(fields.get(name)?.trim() ?? '');
  for (const required of ['编号', '题型', '题干', '答案']) if (!get(required)) throw new Error(`缺少“${required}”或内容为空。`);
  const number = get('编号');
  if (number.length > 100 || number.includes('\n')) throw new Error('编号必须为不超过 100 字符的单行文本。');
  const kindLabel = get('题型');
  if (!(kindLabel in kindMap)) throw new Error('题型只支持：单选、多选、判断、填空、简答。');
  const kind = kindMap[kindLabel as keyof typeof kindMap];
  const question: QuestionSnapshot = { key: number, fingerprint: number, number, kind, stem: get('题干'),
    options: [], fields: [], children: [], images: [], supported: true };
  let answer: ApplicableAnswer;
  if (kind === 'single' || kind === 'multiple') {
    if (fields.has('空数')) throw new Error('选择题不能填写空数。');
    question.options = parseOptions(fields.get('选项')?.trim() ?? '');
    const choices = get('答案').split(',').map(s => s.trim());
    if (!choices.every(c => /^[A-Z]$/.test(c)) || new Set(choices).size !== choices.length
      || (kind === 'single' && choices.length !== 1)) throw new Error('单选答案写 A，多选答案写 A,C，不能重复。');
    answer = { choices: choices.map(label => question.options.find(o => o.label === label)?.id ?? '') };
  } else if (kind === 'judgement') {
    if (fields.has('选项') || fields.has('空数')) throw new Error('判断题不需要选项或空数。');
    if (!['正确', '错误'].includes(get('答案'))) throw new Error('判断题答案必须为“正确”或“错误”。');
    question.options = [{ id: 'true', label: 'A', text: '正确' }, { id: 'false', label: 'B', text: '错误' }];
    answer = { choices: [get('答案') === '正确' ? 'true' : 'false'] };
  } else {
    if (fields.has('选项')) throw new Error('填空或简答不能包含选项字段。');
    if (kindLabel === '填空') {
      const count = Number(get('空数'));
      if (!Number.isSafeInteger(count) || count < 1 || count > 100) throw new Error('填空题必须提供 1 至 100 的空数。');
      const texts: string[] = [];
      for (const line of (fields.get('答案') ?? '').trim().split('\n')) {
        if (!line.trim()) continue;
        const item = line.match(/^(\d+)\.\s+(.+)$/);
        if (!item || Number(item[1]) !== texts.length + 1) throw new Error('填空答案按 1. 内容、2. 内容逐行填写。');
        texts.push(unescape(item[2]));
      }
      if (texts.length !== count) throw new Error('填空答案数量与空数不一致。');
      question.fields = texts.map((_, i) => ({ id: `field-${i + 1}` })); answer = { texts };
    } else {
      if (fields.has('空数')) throw new Error('简答题不需要空数。');
      question.fields = [{ id: 'field-1' }]; answer = { texts: [get('答案')] };
    }
  }
  const record = sanitizeBankEntry({ question, answer });
  return { record, number, kindLabel, explanation: get('解析'), position };
}

/** Parsing never stores data; all errors must be resolved before commit. */
export function parseBankTemplate(text: string, locations?: string[]): BankDraft {
  if (text.length > 6_000_000) throw new Error('提取文本超过 600 万字符，请拆分文件。');
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const draft: BankDraft = { name: '', course: '', declaredCount: 0, items: [], issues: [], duplicates: 0, conflicts: 0 };
  const where = (index: number) => locations?.[index] ?? `第 ${index + 1} 行`;
  const issue = (index: number, message: string) => { if (draft.issues.length < 100) draft.issues.push({ position: where(index), message }); };
  const header = new Map<string, string>(); const ids = new Set<string>(); const identities = new Set<string>();
  const answers = new Map<string, Set<string>>();
  let block: string[] | undefined; let start = 0; let seenBlocks = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (line.trim() === '【题目】') {
      if (block) issue(start, '上一题缺少【结束】。');
      block = []; start = i; seenBlocks++;
      if (seenBlocks > LOCAL_QUESTION_BANK_LIMIT) { issue(i, `每次最多导入 ${LOCAL_QUESTION_BANK_LIMIT} 题。`); break; }
    } else if (line.trim() === '【结束】') {
      if (!block) { issue(i, '【结束】前没有【题目】。'); continue; }
      try {
        const item = parseBlock(block, where(start));
        if (ids.has(item.number)) throw new Error(`编号 ${item.number} 重复。`);
        ids.add(item.number);
        const key = localQuestionContentKey(item.record.question)!;
        const identity = localBankEntryIdentity(item.record);
        const group = answers.get(key) ?? new Set<string>(); group.add(identity); answers.set(key, group);
        if (identities.has(identity)) draft.duplicates++;
        else { identities.add(identity); draft.items.push(item); }
      } catch (error) { issue(start, error instanceof Error ? error.message : '题目格式错误。'); }
      block = undefined;
    } else if (block) block.push(line);
    else if (line.trim()) {
      const match = line.match(/^(题库格式|题库名称|题目总数|课程)[：:]\s*(.*)$/);
      if (seenBlocks || !match || header.has(match[1])) issue(i, '题块外存在未知文本或重复文件头。');
      else header.set(match[1], match[2].trim());
    }
  }
  if (block) issue(start, '题目缺少【结束】。');
  draft.name = header.get('题库名称') ?? ''; draft.course = header.get('课程') ?? '';
  draft.declaredCount = Number(header.get('题目总数'));
  if (header.get('题库格式') !== BANK_TEMPLATE_VERSION) issue(0, '文件头必须写“题库格式：CXQB-1”。');
  if (!draft.name || draft.name.length > 100 || draft.course.length > 200) issue(0, '题库名称必填且不超过 100 字符，课程不超过 200 字符。');
  if (!Number.isSafeInteger(draft.declaredCount) || draft.declaredCount < 1 || draft.declaredCount !== seenBlocks) issue(0, '题目总数缺失或与实际题块数不一致。');
  draft.conflicts = [...answers.values()].filter(group => group.size > 1).length;
  return draft;
}

export function serializeBankTemplate(items: DraftEntry[], name: string, course = ''): string {
  if (!items.length) throw new Error('没有可导出的完整模板题目。');
  const lines = [`题库格式：${BANK_TEMPLATE_VERSION}`, `题库名称：${name.replace(/[\r\n]/g, ' ').slice(0, 100) || '我的题库'}`, `题目总数：${items.length}`];
  if (course) lines.push(`课程：${course.replace(/[\r\n]/g, ' ').slice(0, 200)}`);
  items.forEach((item, index) => {
    const q = item.record.question; const answer = normalizeAnswer(q, item.record.answer);
    if (!answer) throw new Error(`第 ${index + 1} 题答案不完整。`);
    const kind = q.kind === 'single' ? '单选' : q.kind === 'multiple' ? '多选' : q.kind === 'judgement' ? '判断'
      : q.kind === 'completion' ? (item.kindLabel === '简答' ? '简答' : '填空') : '';
    if (!kind) throw new Error('模板支持单选、多选、判断、填空和简答，复杂题型请使用 JSON。');
    lines.push('', '【题目】', `编号：${index + 1}`, `题型：${kind}`);
    if (kind === '填空') lines.push(`空数：${q.fields.length}`);
    lines.push(`题干：${escape(q.stem)}`);
    if (kind === '单选' || kind === '多选') {
      if (q.options.length > 26) throw new Error('选项超过 26 个，无法导出文本模板。');
      lines.push('选项：', ...q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${escape(o.text)}`));
      const letters = answer.choices!.map(id => String.fromCharCode(65 + q.options.findIndex(o => o.id === id)));
      lines.push(`答案：${letters.join(',')}`);
    } else if (kind === '判断') {
      const option = q.options.find(o => o.id === answer.choices?.[0]);
      const meaning = option && judgementMeaning(option.text);
      if (meaning === undefined) throw new Error('判断答案含义不明确，不能导出模板。');
      lines.push(`答案：${meaning ? '正确' : '错误'}`);
    } else if (kind === '简答') lines.push(`答案：${escape(answer.texts![0])}`);
    else {
      if (answer.texts!.some(text => /\r|\n/.test(text))) throw new Error('填空答案包含换行，请使用 JSON 备份以保留内容。');
      lines.push('答案：', ...answer.texts!.map((text, i) => `${i + 1}. ${escape(text)}`));
    }
    if (item.explanation) lines.push(`解析：${escape(item.explanation)}`);
    lines.push('【结束】');
  });
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function draftFromBankEntries(entries: BankEntry[], name: string): BankDraft {
  return { name, course: '', declaredCount: entries.length, issues: [], duplicates: 0, conflicts: 0,
    items: entries.map((record, i) => ({ record, number: String(i + 1), kindLabel: record.question.kind === 'completion' ? '填空' : '', explanation: '', position: `JSON 第 ${i + 1} 题` })) };
}

export const sampleBankTemplate = () => '\uFEFF题库格式：CXQB-1\r\n题库名称：我的题库\r\n题目总数：1\r\n\r\n【题目】\r\n编号：001\r\n题型：单选\r\n题干：下列哪一项是关系数据库管理系统？\r\n选项：\r\nA. MySQL\r\nB. Photoshop\r\n答案：A\r\n解析：MySQL 是关系数据库管理系统。\r\n【结束】\r\n';
