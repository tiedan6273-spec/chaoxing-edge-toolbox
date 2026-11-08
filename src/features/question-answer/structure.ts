/** Observe question/frame identity, never answer values or editor content changes. */
export function observeQuestionStructure(doc: Document, changed: () => void): () => void {
  const win = doc.defaultView;
  if (!win) return () => {};
  const selector = '.TiMu,.questionLi,.question-item,.questiono-item,.subject-item,.exam-question,[data-question-id],form#form1,form#submitForm,iframe';
  let href = doc.URL;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function excluded(element: Element): boolean {
    return Boolean(element.closest('[data-cx-toolbox],#cx-toolbox-root,.edui-editor,.edui-editor-iframeholder'))
      || element.tagName === 'IFRAME' && (/^ueditor_/i.test(element.id) || /^javascript:/i.test(element.getAttribute('src') ?? ''));
  }
  function relevant(node: Node): boolean {
    if (node.nodeType !== 1) return false;
    const element = node as Element;
    if (excluded(element)) return false;
    return element.matches(selector) || [...element.querySelectorAll(selector)].some(child => !excluded(child));
  }
  function schedule(): void {
    if (timer !== undefined) return;
    timer = setTimeout(() => { timer = undefined; changed(); }, 30);
  }
  const observer = new win.MutationObserver(records => {
    if (records.some(record => record.type === 'childList'
      ? [...record.addedNodes, ...record.removedNodes].some(relevant)
      : record.target.nodeType === 1 && relevant(record.target)
        && ((record.attributeName === 'src' && (record.target as Element).tagName === 'IFRAME')
          || (record.attributeName === 'action' && (record.target as Element).matches('form#form1,form#submitForm'))))) schedule();
  });
  observer.observe(doc, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'action'] });
  const loaded = (event: Event) => {
    const target = event.target as Node | null;
    if (target?.nodeType === 1 && (target as Element).tagName === 'IFRAME' && !excluded(target as Element)) schedule();
  };
  doc.addEventListener('load', loaded, true);
  const routeMonitor = setInterval(() => { if (href !== doc.URL) { href = doc.URL; schedule(); } }, 500);
  return () => { observer.disconnect(); doc.removeEventListener('load', loaded, true); clearTimeout(timer); clearInterval(routeMonitor); };
}
