import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { emptyLedger, type ActivityStatus } from '../src/features/activity/types';
import { createUsageDashboard } from '../src/features/activity/dashboard';

test('usage cards show shared known costs and token subsets; unknown, unset and failed reads stay explicit', () => {
  const dom = new JSDOM(); const previous = Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:dom.window.document});
  try {
    let refresh=0, settings=0; const view=createUsageDashboard(()=>refresh++,()=>settings++);
    const status: ActivityStatus={settings:{retentionDays:7,budget:2},ledger:{...emptyLedger(),cost:.5,requests:4,input:1000,output:200,cached:400,reasoning:50},model:'m',identity:'id',priced:true,historyCount:0};
    view.update(status);
    const text=(name:string)=>view.element.querySelector(`[data-stat=${name}]`)!.textContent;
    assert.equal(text('remaining'),'¥1.5000'); assert.equal(text('requests'),'4'); assert.equal(text('input'),'1,000');
    assert.match(view.element.querySelector('.usage-token-details')!.textContent!,/缓存 400.*思考 50/);
    status.ledger.unknown=1;view.update(status);assert.equal(text('remaining'),'待核对');
    status.settings.budget=0;view.update(status);assert.equal(text('remaining'),'未设预算');
    view.update(undefined,'读取失败');assert.equal(text('cost'),'—');assert.equal(text('remaining'),'—');
    view.element.querySelector<HTMLButtonElement>('.dashboard-refresh')!.click();view.element.querySelector<HTMLButtonElement>('.dashboard-settings')!.click();
    assert.equal(refresh,1);assert.equal(settings,1);
  } finally {dom.window.close();if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');}
});
