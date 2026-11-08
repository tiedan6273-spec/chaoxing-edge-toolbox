/** An inert placeholder must never become a searchable answer or question. */
export function hasUnresolvedDocumentContent(text: string): boolean {
  return /〔(?:图片或对象|公式)待校对\d*〕/.test(text);
}
