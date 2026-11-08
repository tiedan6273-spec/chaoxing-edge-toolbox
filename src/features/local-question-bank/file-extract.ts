import { strFromU8, unzipSync } from 'fflate';

export interface ExtractedBankText { text: string; locations: string[]; warnings?: string[]; previews?: import('./document-types').SourcePreview[] }
export function docxParagraphText(raw: string): ExtractedBankText {
  const lines: string[] = []; const locations: string[] = [];
  raw.replace(/\r\n?/g, '\n').split('\n\n').forEach((paragraph, index) => {
    const parts = paragraph.split('\n'); lines.push(...parts);
    locations.push(...parts.map(() => `DOCX 段落 ${index + 1}`));
  });
  return { text: lines.join('\n'), locations };
}
export function decodeBankText(bytes: Uint8Array, encoding: 'utf-8' | 'gb18030' = 'utf-8'): ExtractedBankText {
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw new Error('文本编码无法解码。可选择 GB18030/GBK 后重新读取，或另存为 UTF-8。'); }
  if (text.includes('\0') || text.includes('\uFFFD')) throw new Error('文件含无法识别的字符，请另存为 UTF-8 TXT。');
  text = text.replace(/\r\n?/g, '\n');
  return { text, locations: text.split('\n').map((_, i) => `第 ${i + 1} 行`) };
}
export function inspectBankDocx(bytes: Uint8Array): void {
  let total = 0; let count = 0;
  const files = unzipSync(bytes, { filter(file) {
    count++; total += file.originalSize;
    if (count > 2000 || file.originalSize > 12_000_000 || total > 40_000_000) throw new Error('DOCX 解压后内容过大，请拆分文档。');
    return /^(?:word\/.*\.xml|\[Content_Types\]\.xml)$/.test(file.name);
  } });
  if (!files['word/document.xml']) throw new Error('这不是有效的 Word DOCX 文件；旧 DOC 请另存为 DOCX。');
  for (const [name, value] of Object.entries(files)) {
    const xml = strFromU8(value);
    if (name === 'word/document.xml' && /<(?:\w+:)?(?:tbl|drawing|object|pict|numPr|vertAlign|oMath|oMathPara|fldChar)\b/.test(xml)) throw new Error('文档包含表格、图片、公式、自动编号或上下标格式，请改用固定模板纯文本。');
    if (/word\/(?:header|footer)\d+\.xml$/.test(name) && /<w:t(?:\s[^>]*)?>[^<]+/.test(xml)) throw new Error('文档含页眉页脚文字，请移除后再导入，避免混入题干或答案。');
  }
}
export interface PdfTextItem { str: string; transform: number[]; width: number; height: number; hasEOL?: boolean }
export function reconstructPdfPage(items: PdfTextItem[], page: number): ExtractedBankText {
  const runs = items.filter(item => item.str.length > 0);
  if (!runs.some(item => item.str.trim())) throw new Error(`PDF 第 ${page} 页没有可提取的文字，可能是扫描件；请先 OCR 或转成模板 TXT。`);
  if (runs.some(item => item.str.includes('\uFFFD') || item.str.includes('\0') || Math.abs(item.transform[1]) > 0.1 || Math.abs(item.transform[2]) > 0.1)) throw new Error(`PDF 第 ${page} 页含无法可靠读取的字符或旋转排版，请转为模板 TXT。`);
  runs.sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);
  const rows: PdfTextItem[][] = [];
  for (const run of runs) {
    const row = rows.at(-1);
    if (row && Math.abs(row[0].transform[5] - run.transform[5]) <= Math.max(1, Math.min(row[0].height, run.height) * 0.25)) row.push(run);
    else rows.push([run]);
  }
  const lines = rows.map(row => {
    row.sort((a, b) => a.transform[4] - b.transform[4]);
    let line = ''; let end = 0;
    for (const run of row) {
      const gap = run.transform[4] - end;
      if (line && gap > Math.max(35, run.height * 4)) throw new Error(`PDF 第 ${page} 页可能使用多栏排版，请改为单栏模板。`);
      if (line && gap > run.height * 0.2 && /[A-Za-z0-9]$/.test(line) && /^[A-Za-z0-9]/.test(run.str)) line += ' ';
      line += run.str; end = run.transform[4] + run.width;
    }
    return line;
  });
  return { text: lines.join('\n'), locations: lines.map((_, i) => `PDF 第 ${page} 页第 ${i + 1} 行`) };
}
