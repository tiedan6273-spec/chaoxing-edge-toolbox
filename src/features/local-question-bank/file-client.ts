import type { ExtractedBankText } from './file-extract';
import { defaultImportOptions, type ImportOptions } from './document-types';

export async function readBankFile(file: File, signal: AbortSignal, progress: (message: string) => void, encoding: 'utf-8' | 'gb18030' = 'utf-8', options: ImportOptions = { ...defaultImportOptions(), mode: 'strict' }): Promise<ExtractedBankText> {
  const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
  if (['png','jpg','jpeg','webp'].includes(extension) || options.mode !== 'strict' && ['pdf','docx'].includes(extension)) {
    const { readAdvancedDocument } = await import('./advanced-reader');
    return readAdvancedDocument(file, options, signal, progress);
  }
  if (!['txt', 'json', 'pdf', 'docx'].includes(extension)) throw new Error('请选择 TXT、DOCX、文字型 PDF 或题库 JSON；旧 DOC 请另存为 DOCX。');
  if (file.size > (extension === 'txt' || extension === 'json' ? 5 : 20) * 1024 * 1024 || !file.size) throw new Error('文件为空或超出大小限制：TXT/JSON 5 MB，DOCX/PDF 20 MB。');
  if (signal.aborted) throw new DOMException('已取消导入。', 'AbortError');
  const buffer = await file.arrayBuffer();
  if (signal.aborted) throw new DOMException('已取消导入。', 'AbortError');
  return new Promise((resolve, reject) => {
    const worker = new Worker(chrome.runtime.getURL('local-bank/import-worker.js'), { type: 'module' });
    const cleanup = () => { clearTimeout(timeout); signal.removeEventListener('abort', abort); worker.terminate(); };
    const abort = () => { cleanup(); reject(new DOMException('已取消导入。', 'AbortError')); };
    const timeout = setTimeout(() => { cleanup(); reject(new Error('文件解析超过 90 秒，请拆分或转换成 TXT。')); }, 90_000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = event => {
      if (event.data.type === 'progress') progress(event.data.message);
      else if (event.data.type === 'result') { cleanup(); resolve({ text: event.data.text, locations: event.data.locations }); }
      else if (event.data.type === 'error') { cleanup(); reject(new Error(event.data.message || '文件解析失败。')); }
    };
    worker.onerror = () => { cleanup(); reject(new Error('文件解析组件未能启动，请重新加载扩展后重试。')); };
    worker.postMessage({ buffer, extension, encoding }, [buffer]);
  });
}
