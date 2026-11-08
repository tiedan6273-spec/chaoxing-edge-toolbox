import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { FEATURES } from '../src/features/catalog';
import { defaultSettings, type Settings } from '../src/features/toolbox-settings/types';
import { mountToolboxSettings } from '../src/features/toolbox-settings/ui';

function fixture() {
  const dom = new JSDOM('<main id="settings"></main>');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const writes: Settings[] = [];
  const control = { failWrite: false };
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { runtime: {
    id: 'settings-test', onMessage: { addListener() {}, removeListener() {} },
    async sendMessage(message: { type: string; settings?: Settings }) {
      if (message.type === 'toolbox:settings:write') {
        if (control.failWrite) return { ok: false, error: 'write failed' };
        writes.push(structuredClone(message.settings!));
        return { ok: true };
      }
      return { ok: true, value: defaultSettings() };
    },
  } } });
  const root = dom.window.document.querySelector<HTMLElement>('#settings')!;
  const dispose = mountToolboxSettings(root);
  return {
    dom, root, writes, control,
    close() {
      dispose(); dom.window.close();
      if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
      else Reflect.deleteProperty(globalThis, 'document');
      if (previousChrome) Object.defineProperty(globalThis, 'chrome', previousChrome);
      else Reflect.deleteProperty(globalThis, 'chrome');
    },
  };
}
const settled = () => new Promise<void>(resolve => setImmediate(resolve));

test('shared platform features have one ID, one switch, and a clear scope', async () => {
  const view = fixture();
  try {
    await settled();
    const inputs = [...view.root.querySelectorAll<HTMLInputElement>('input[id^="feature-"]')];
    assert.equal(inputs.length, FEATURES.length);
    assert.equal(new Set(inputs.map(input => input.id)).size, FEATURES.length);
    assert.ok(inputs.every(input => !input.disabled));
    const shared = view.root.querySelector('[data-platform="shared"]')!;
    assert.ok(shared.querySelector('#feature-question-answer'));
    assert.ok(shared.querySelector('#feature-ai-answer'));
    assert.match(shared.textContent!, /同时应用于学习通与浙学/);
    assert.equal(view.root.querySelector('[data-platform="chaoxing"] #feature-question-answer'), null);
  } finally { view.close(); }
});

test('a shared switch saves its common feature setting exactly once', async () => {
  const view = fixture();
  try {
    await settled();
    const toggle = view.root.querySelector<HTMLInputElement>('#feature-question-answer')!;
    toggle.checked = false;
    toggle.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
    await settled();
    assert.equal(view.writes.length, 1);
    assert.equal(view.writes[0].features['question-answer'], false);
    assert.equal(toggle.disabled, false);
    assert.equal(toggle.checked, false);
  } finally { view.close(); }
});

test('failed settings writes restore the last known switch value', async () => {
  const view = fixture();
  try {
    await settled(); view.control.failWrite = true;
    const toggle = view.root.querySelector<HTMLInputElement>('#feature-question-answer')!;
    toggle.checked = false;
    toggle.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
    await settled();
    assert.equal(toggle.checked, true);
    assert.equal(toggle.disabled, false);
    assert.match(view.root.querySelector('.feedback')!.textContent!, /保存失败/);
  } finally { view.close(); }
});
