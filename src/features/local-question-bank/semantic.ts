export function judgementMeaning(text: string): boolean | undefined {
  const value = text.normalize('NFC').trim();
  if (['正确', '对', '是', '√', 'true', 'True', 'TRUE'].includes(value)) return true;
  if (['错误', '错', '否', '×', 'false', 'False', 'FALSE'].includes(value)) return false;
  return;
}
