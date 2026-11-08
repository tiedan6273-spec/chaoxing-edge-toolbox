export function createOcrSession(language: string, signal: AbortSignal, progress: (text: string) => void) {
  const worker = new Worker(chrome.runtime.getURL('local-bank/ocr-host.js'), { type: 'module' });
  let pending: { id: string; resolve(value: { text: string; confidence: number }): void; reject(error: Error): void } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined; let closed = false;
  function close(message = 'OCR 已取消，未导入题库。') {
    closed = true; clearTimeout(timer); signal.removeEventListener('abort', abort); worker.terminate();
    pending?.reject(new Error(message)); pending = undefined;
  }
  const abort = () => close(); signal.addEventListener('abort', abort, { once: true });
  worker.onerror = () => close('本地 OCR 组件未能启动，请重载扩展后重试。');
  worker.onmessage = event => {
    const m = event.data as { type: string; id?: string; text: string; confidence: number; message: string };
    if (closed) return;
    if (m.type === 'progress') { progress(m.text); return; }
    if (!pending || m.id !== pending.id) return; clearTimeout(timer); const current = pending; pending = undefined;
    if (m.type === 'result' && typeof m.text === 'string' && Number.isFinite(m.confidence)) current.resolve({ text: m.text, confidence: m.confidence });
    else current.reject(new Error(m.message || 'OCR 返回无效内容。'));
  };
  return { close,
    async recognize(canvas: HTMLCanvasElement, singleBlock = false) {
      if (closed || signal.aborted) throw new Error('OCR 已取消。');
      if (pending) throw new Error('上一张图片尚未识别完成。');
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('图片无法编码。')), 'image/png'));
      const buffer = await blob.arrayBuffer(); if (closed || signal.aborted) throw new Error('OCR 已取消。');
      return new Promise<{ text: string; confidence: number }>((resolve, reject) => {
        const id = crypto.randomUUID(); pending = { id, resolve, reject };
        timer = setTimeout(() => close('本页 OCR 超过 60 秒，请缩小区域或分批读取。'), 60000);
        worker.postMessage({ id, language, singleBlock, root: chrome.runtime.getURL('vendor/ocr'), buffer }, [buffer]);
      });
    },
  };
}
