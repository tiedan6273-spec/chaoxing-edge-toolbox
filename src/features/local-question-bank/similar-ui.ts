import { requestExtension } from '../../core/extension-rpc';
import { formatApplicableAnswer } from '../question-answer/answer-format';
import type { QuestionSnapshot } from '../question-answer/types';
import type { SimilarCandidate } from './similar';
import { getLibraryState } from './library-client';

const references = new Set<WeakRef<HTMLElement>>();
let listening = false;
function registerReference(root: HTMLElement) {
  references.add(new WeakRef(root));
  if (listening) return; listening = true;
  chrome.runtime.onMessage.addListener((message: { type?: string }, sender: chrome.runtime.MessageSender) => {
    if (sender.id !== chrome.runtime.id || message.type !== 'toolbox:local-question-bank:changed') return;
    for (const ref of references) { const element = ref.deref(); if (!element?.isConnected) references.delete(ref); else element.dispatchEvent(new Event('library-invalidated')); }
  });
}

export function createSimilarView(read: () => QuestionSnapshot | undefined): HTMLElement {
  const root = document.createElement('details'); root.className = 'similar-references';
  const summary = document.createElement('summary'); summary.textContent = '相似题参考';
  const help = document.createElement('p'); help.textContent = '仅检索当前选库。相似题供核对，不自动填写；排序不代表答案正确率。';
  const search = document.createElement('button'); search.type = 'button'; search.className = 'button'; search.textContent = '查看相似题';
  const list = document.createElement('div'); const status = document.createElement('p'); status.setAttribute('role', 'status');
  let generation = 0;
  root.addEventListener('library-invalidated', () => { generation++; list.replaceChildren(); status.textContent = '题库已变化，请重新查看相似题。'; }); registerReference(root);
  search.onclick = () => {
    const q = read(); if (!q || search.disabled) return; search.disabled = true; status.textContent = '正在检索本地参考题…'; list.replaceChildren();
    const own = ++generation;
    void requestExtension<{ revision: number; candidates: SimilarCandidate[] }>('toolbox:local-libraries:similar', { question: q }).then(data => {
      if (own !== generation || read()?.fingerprint !== q.fingerprint) { status.textContent = '题目或题库已变化，请重新查询。'; return; }
      status.textContent = data.candidates.length ? `找到 ${data.candidates.length} 道参考题。` : '未找到相似题，请先启用并选择适用的本地题库。';
      for (const c of data.candidates) {
        const card = document.createElement('article'); const title = document.createElement('strong'); title.textContent = c.library;
        const stem = document.createElement('p'); stem.textContent = c.question.stem;
        const options = document.createElement('p'); options.textContent = c.question.options.map(o => `${o.label}. ${o.text}`).join('\n');
        const answer = document.createElement('pre'); answer.textContent = `参考答案：${formatApplicableAnswer(c.question, c.answer)}\n${c.explanation}`;
        const difference = document.createElement('p'); difference.className = 'similar-differences'; difference.textContent = c.differences.join('；');
        const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'button'; copy.textContent = '复制参考';
        copy.onclick = () => { void getLibraryState().then(current => { if (current.revision !== data.revision || own !== generation) throw new Error('题库已变化'); return navigator.clipboard.writeText(`${c.question.stem}\n${options.textContent}\n${answer.textContent}`); }).then(() => { status.textContent = '参考内容已复制，请核对题目差异。'; }).catch(() => { status.textContent = '题库已变化或复制失败，请重新检索并核对。'; }); };
        card.append(title, stem, options, difference, answer, copy); list.append(card);
      }
    }).catch(e => { status.textContent = e instanceof Error ? e.message : '检索失败。'; }).finally(() => { search.disabled = false; });
  };
  root.append(summary, help, search, status, list); return root;
}
