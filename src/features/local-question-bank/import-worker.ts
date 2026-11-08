import mammoth from 'mammoth';
import { getDocument, GlobalWorkerOptions, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { decodeBankText, docxParagraphText, inspectBankDocx, reconstructPdfPage, type PdfTextItem } from './file-extract';

GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.mjs', import.meta.url).href;
const worker = globalThis as unknown as { onmessage: (event: MessageEvent) => void; postMessage(value: unknown): void };
worker.onmessage = event => {
  const { buffer, extension, encoding } = event.data as { buffer: ArrayBuffer; extension: string; encoding: 'utf-8' | 'gb18030' };
  void (async () => {
    try {
      const bytes = new Uint8Array(buffer);
      if (extension === 'txt' || extension === 'json') { worker.postMessage({ type: 'result', ...decodeBankText(bytes, encoding) }); return; }
      if (extension === 'docx') {
        inspectBankDocx(bytes);
        const result = await mammoth.extractRawText({ arrayBuffer: buffer });
        if (result.messages.some(message => message.type === 'error')) throw new Error('Word 提取失败，请另存为固定模板 TXT 后重试。');
        worker.postMessage({ type: 'result', ...docxParagraphText(result.value) }); return;
      }
      if (extension !== 'pdf') throw new Error('支持 TXT、DOCX、文字型 PDF 和已有题库 JSON；旧 DOC 请另存为 DOCX。');
      const task = getDocument({ data: bytes, useWasm: false, useSystemFonts: true,
        cMapUrl: new URL('../vendor/cmaps/', import.meta.url).href, cMapPacked: true,
        standardFontDataUrl: new URL('../vendor/standard_fonts/', import.meta.url).href, disableFontFace: true, stopAtErrors: true });
      try {
        const pdf = await task.promise;
        if (pdf.numPages > 200) throw new Error('PDF 超过 200 页，请拆分后导入。');
        const texts: string[] = []; const locations: string[] = []; let size = 0;
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
          worker.postMessage({ type: 'progress', message: `正在读取 PDF：${pageNumber}/${pdf.numPages} 页` });
          const page = await pdf.getPage(pageNumber); const content = await page.getTextContent();
          const operators = await page.getOperatorList();
          const imageOperations = new Set(Object.entries(OPS).filter(([name]) => /^paint.*Image/.test(name)).map(([, op]) => op));
          if (operators.fnArray.some(op => imageOperations.has(op))) throw new Error(`PDF 第 ${pageNumber} 页包含图片或扫描内容，请整理为纯文本模板，未跳过图片入库。`);
          const items = content.items.filter((item): item is typeof item & PdfTextItem => 'str' in item);
          if (!items.some(item => item.str.trim())) {
            if (operators.fnArray.length) throw new Error(`PDF 第 ${pageNumber} 页没有可提取文字，可能为扫描件；未导入。`);
            page.cleanup(); continue;
          }
          const result = reconstructPdfPage(items, pageNumber);
          size += result.text.length; if (size > 6_000_000) throw new Error('PDF 提取文字过多，请拆分文件。');
          texts.push(result.text); locations.push(...result.locations); page.cleanup();
        }
        worker.postMessage({ type: 'result', text: texts.join('\n'), locations });
      } finally { await task.destroy(); }
    } catch (error) {
      const detail = error && typeof error === 'object' && 'message' in error ? String(error.message).slice(0, 500) : '';
      worker.postMessage({ type: 'error', message: /Password|password/.test(detail)
        ? 'PDF 受密码保护，请先在本机解密并另存后导入。' : detail || '文件读取失败，请转换为模板 TXT。' });
    }
  })();
};
