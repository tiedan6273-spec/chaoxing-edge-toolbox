import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { inspectZjoocQuestionPage } from '../src/features/question-answer/adapters/zjooc';
import { readQuestionControl } from '../src/features/question-answer/adapters/chaoxing';
import { handleAnswerPageCommand } from '../src/features/question-answer/page';
import { inspectPaperFlow } from '../src/features/question-answer/flow-page';
import { createPaperFlowController, type PaperFlowProgress } from '../src/features/question-answer/flow-controller';
import { createQuestionAnswerController } from '../src/features/question-answer/controller';
import type { AnswerPageCommand } from '../src/features/question-answer/types';
import type { AnswerRuntime } from '../src/features/question-answer/client';

export const paginatedHtml = '<!doctype html><main class="exam-paper"><input name="examId" value="qa-paper"><h1 class="exam-title">本地分页样本</h1><section class="question-item" data-question-id="q1"><h3 class="question-title">第一页问题</h3><label><input name="q" type="radio" value="a">A. 甲</label><label><input name="q" type="radio" value="b">B. 乙</label></section><button type="button" id="save">保存草稿</button><button type="button" id="submit">交卷</button><div class="el-pagination">共 2 页<ul class="el-pager"><li class="active">1</li></ul><button type="button" class="btn-next">下一页</button></div><p class="save-status" role="status"></p></main>';
function harness() {
  const dom = new JSDOM(paginatedHtml, { url: 'https://www.zjooc.cn/ucenter/student/exam/qa?examId=qa-paper' }); const win = dom.window as unknown as Window;
  const calls = { save: 0, next: 0, submit: 0 }; let acknowledge = true;
  dom.window.document.getElementById('save')!.onclick = () => { calls.save++; if (acknowledge) { const p = dom.window.document.createElement('p'); p.className = 'el-message'; p.textContent = '保存成功'; dom.window.document.body.append(p); } };
  dom.window.document.getElementById('submit')!.onclick = () => { calls.submit++; };
  (dom.window.document.querySelector('.btn-next') as HTMLButtonElement).onclick = () => { calls.next++; dom.window.document.querySelector('.el-pager .active')!.textContent = '2'; dom.window.document.querySelector('.question-item')!.setAttribute('data-question-id', 'q2'); dom.window.document.querySelector('.question-title')!.textContent = '第二页问题'; for (const r of dom.window.document.querySelectorAll<HTMLInputElement>('input[type=radio]')) r.checked = false; (dom.window.document.querySelector('.btn-next') as HTMLButtonElement).disabled = true; };
  const inspect = () => inspectZjoocQuestionPage(win);
  const command = (operation: 'inspect' | 'save' | 'next', expected = false): Extract<AnswerPageCommand, {action:'flow'}> => {
    const page = inspect(); const flow = inspectPaperFlow(win, page);
    return { action:'flow', operation, documentKey: page.snapshot.documentKey, scopeKey: page.snapshot.scopeKey, attemptKey: flow.attemptKey, pageKey: flow.pageKey,
      ...(expected ? { expected: page.entries.map(e => ({ key:e.snapshot.key, fingerprint:e.snapshot.fingerprint, version:readQuestionControl(win,e).version })) } : {}) };
  };
  return { dom, win, calls, inspect, command, setAck(value:boolean){ acknowledge=value; }, fill() { dom.window.document.querySelector<HTMLInputElement>('input[type=radio]')!.checked=true; } };
}
test('filled answers alone cannot navigate; a fresh native save acknowledgement permits one guarded next', async () => {
  const h=harness(); try {h.fill(); assert.equal((await handleAnswerPageCommand(h.win,h.command('next',true))).ok,false); assert.equal(h.calls.next,0);
    assert.equal((await handleAnswerPageCommand(h.win,h.command('save',true))).outcome,'saved');
    assert.equal((await handleAnswerPageCommand(h.win,h.command('next',true))).ok,true); assert.equal(h.calls.next,1);assert.equal(h.calls.submit,0);
    const info=inspectPaperFlow(h.win,h.inspect());assert.equal(info.page,2);assert.equal(info.terminal,true);assert.equal(info.canNext,false);
  } finally {h.dom.window.close();}
});
test('editing after save and cancelling during a save wait prevent later navigation', async () => {
  const h=harness();try {h.fill();const next=h.command('next',true);await handleAnswerPageCommand(h.win,h.command('save',true));
    h.dom.window.document.querySelector<HTMLInputElement>('input[value=b]')!.checked=true;
    assert.equal((await handleAnswerPageCommand(h.win,next)).ok,false);assert.equal(h.calls.next,0);
    h.setAck(false);const pending=handleAnswerPageCommand(h.win,h.command('save',true));await handleAnswerPageCommand(h.win,{action:'cancel'});
    assert.equal((await pending).ok,false);assert.equal(h.calls.next,0);assert.equal(h.calls.submit,0);
  }finally{h.dom.window.close();}
});
test('missing paper identity and ambiguous next controls do not offer navigation', () => {
  const h=harness();try{h.dom.window.document.querySelector('input[name=examId]')!.remove();h.dom.reconfigure({url:'https://www.zjooc.cn/ucenter/student/exam/qa'});
    assert.equal(inspectPaperFlow(h.win,h.inspect()).canNext,false);
    h.dom.reconfigure({url:'https://www.zjooc.cn/ucenter/student/exam/qa?examId=qa'});
    const clone=h.dom.window.document.querySelector('.btn-next')!.cloneNode(true);h.dom.window.document.querySelector('.el-pagination')!.append(clone);
    assert.equal(inspectPaperFlow(h.win,h.inspect()).canNext,false);
  }finally{h.dom.window.close();}
});
test('real queue and page handlers process two constructed pages, save both, and leave final submission untouched', async () => {
  const h=harness(); let progress:PaperFlowProgress|undefined;
  const runtime:AnswerRuntime={scan:async()=>[{frameId:0,snapshot:h.inspect().snapshot}],page:async(_,command)=>{const r=await handleAnswerPageCommand(h.win,command);if(!r.ok)throw new Error(r.error);return r;},cancel(){void handleAnswerPageCommand(h.win,{action:'cancel'});}};
  const answer=createQuestionAnswerController({runtime,isEnabled:()=>true,getSources:async()=>({selection:'ai',bank:{configured:false,authorized:false},ai:{enabled:true,configured:true,authorized:true}}),saveSource:async()=>{},generate:async()=>({status:'answer',source:'ai',text:'甲',answer:{choices:['option-1']}})});
  answer.setMode!('fill');const flow=createPaperFlowController({runtime,answer,stopAnswer:()=>answer.stop(),isEnabled:()=>true,load:async()=>progress,save:async v=>{progress=structuredClone(v);},clear:async()=>{progress=undefined;}});
  try{flow.start();for(let i=0;i<300&&(!flow.getState().progress||flow.getState().running);i++)await new Promise(r=>setTimeout(r,10));
    assert.equal(flow.getState().running,false,flow.getState().message);assert.equal(flow.getState().progress?.pages,2,JSON.stringify({flow:flow.getState(),answer:answer.getState()}));
    assert.equal(flow.getState().progress?.saved,2);assert.deepEqual(h.calls,{save:2,next:1,submit:0});assert.equal(progress,undefined);
  }finally{flow.dispose();answer.dispose();h.dom.window.close();}
});
