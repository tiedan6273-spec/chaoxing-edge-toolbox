/** A captured graded paper is readable even when its route is not yet known. */
export function isZjoocReviewDocument(doc: Document): boolean {
  return [...doc.querySelectorAll('main.common_look')].some(shell => {
    for (let node: Element | null = shell; node; node = node.parentElement) {
      const style = doc.defaultView?.getComputedStyle(node);
      if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true' || style?.display === 'none' || style?.visibility === 'hidden') return false;
    }
    const roots = [...shell.querySelectorAll('.common-question .questiono-item')];
    return roots.length > 0 && roots.every(root => root.querySelector('.common_test_myanswer,.common_test_score'))
      && [...shell.querySelectorAll<HTMLInputElement>('input[type=radio],input[type=checkbox]')].every(input => input.disabled);
  });
}
