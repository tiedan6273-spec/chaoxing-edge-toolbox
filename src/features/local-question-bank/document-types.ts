export interface ImportOptions { mode: 'auto' | 'strict' | 'ocr'; pages: string; layout: 'auto' | 'rows' | 'columns' | 'columns-right'; language: 'chi_sim+eng' | 'eng'; crop: string }
export const defaultImportOptions = (): ImportOptions => ({ mode: 'auto', pages: '', layout: 'auto', language: 'chi_sim+eng', crop: '' });
export interface SourcePreview { label: string; text: string; image?: string }
export interface DocumentExtraction { text: string; locations: string[]; warnings: string[]; previews: SourcePreview[] }
export function selectedPages(value: string, total: number, limit = 200): number[] {
  if (!Number.isSafeInteger(total) || total < 1 || total > 200) throw new Error('PDF 最多 200 页，请拆分文件。');
  const result = new Set<number>();
  if (!value.trim()) { for (let n = 1; n <= total; n++) result.add(n); }
  else for (const part of value.split(/[,，]/)) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part.trim()); if (!match) throw new Error('页码范围示例：1-5,8。');
    const start = Number(match[1]), end = Number(match[2] ?? match[1]); if (start < 1 || end < start || end > total) throw new Error('页码范围超出文件或起止顺序无效。');
    for (let n = start; n <= end; n++) result.add(n);
  }
  if (result.size > limit) throw new Error(`本轮最多处理 ${limit} 页，请选择页码范围。`); return [...result].sort((a,b) => a-b);
}
export function cropPercent(value: string): [number, number, number, number] {
  if (!value.trim()) return [0,0,100,100]; const parts = value.split(/[,，\s]+/).map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n)) || parts[0] < 0 || parts[1] < 0 || parts[2] <= 0 || parts[3] <= 0 || parts[0]+parts[2] > 100 || parts[1]+parts[3] > 100) throw new Error('截取范围应为 x,y,宽,高，均为百分比且在页面内。');
  return parts as [number,number,number,number];
}
