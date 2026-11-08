import { createWorker, PSM, type Worker } from 'tesseract.js';

const host = globalThis as unknown as { onmessage: (event: MessageEvent) => void; postMessage(value: unknown): void };
let engine: Promise<Worker> | undefined;
host.onmessage = event => {
  const value = event.data as { type: string; id: string; language: string; root: string; buffer: ArrayBuffer; singleBlock: boolean };
  void (async () => {
    try {
      engine ??= createWorker(value.language, 1, { workerPath: `${value.root}/worker.min.js`, corePath: `${value.root}/core`, langPath: `${value.root}/lang`, workerBlobURL: false, cacheMethod: 'none', gzip: true,
        logger: message => host.postMessage({ type: 'progress', text: `本机 OCR：${Math.round(message.progress * 100)}%` }) });
      const worker = await engine;
      await worker.setParameters({ tessedit_pageseg_mode: value.singleBlock ? PSM.SINGLE_BLOCK : PSM.AUTO });
      const result = await worker.recognize(new Blob([value.buffer], { type: 'image/png' }), { rotateAuto: true }, { text: true });
      host.postMessage({ type: 'result', id: value.id, text: result.data.text, confidence: result.data.confidence });
    } catch (e) { host.postMessage({ type: 'error', id: value.id, message: e instanceof Error ? e.message.slice(0, 500) : 'OCR 识别失败。' }); }
  })();
};
