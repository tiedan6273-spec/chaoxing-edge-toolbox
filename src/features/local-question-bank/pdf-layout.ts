import type { PdfTextItem } from './file-extract';
import type { ImportOptions } from './document-types';

export function reconstructPdfLayout(items: PdfTextItem[], width: number, page: number, layout: ImportOptions['layout']): { text: string; locations: string[]; warnings: string[] } {
  const runs=items.filter(i=>i.str.length); if(runs.some(i=>i.str.includes('\uFFFD')||i.str.includes('\0')))throw new Error(`第 ${page} 页含缺字，请改用 OCR 或人工整理。`);
  if(runs.some(i=>Math.abs(i.transform[1])>.1||Math.abs(i.transform[2])>.1))throw new Error(`第 ${page} 页含旋转文字，请选择 OCR 后读取。`);
  const left=runs.filter(i=>i.transform[4]<width*.48),right=runs.filter(i=>i.transform[4]>=width*.48);
  const likely=left.length>2&&right.length>2&&left.filter(i=>i.transform[4]+i.width>width*.53).length<2;
  const columns=layout==='columns'||layout==='columns-right'||layout==='auto'&&likely;
  const groups=columns?(layout==='columns-right'?[right,left]:[left,right]):[runs];
  const lines:string[]=[];const locations:string[]=[];
  groups.forEach((group,column)=>{
    const sorted=[...group].sort((a,b)=>b.transform[5]-a.transform[5]||a.transform[4]-b.transform[4]);const rows:PdfTextItem[][]=[];
    for(const item of sorted){const last=rows.at(-1);if(last&&Math.abs(last[0].transform[5]-item.transform[5])<=Math.max(1,Math.min(last[0].height,item.height)*.3))last.push(item);else rows.push([item]);}
    for(const row of rows){let text='',end=0;for(const item of row.sort((a,b)=>a.transform[4]-b.transform[4])){const gap=item.transform[4]-end;
      if(text&&gap>item.height*.25&&/[A-Za-z0-9]$/.test(text)&&/^[A-Za-z0-9]/.test(item.str))text+=' ';text+=item.str;end=item.transform[4]+item.width;}
      lines.push(text);locations.push(`PDF 第 ${page} 页${columns?`第 ${column+1} 栏`:''}第 ${rows.indexOf(row)+1} 行`);}
  });
  return {text:lines.join('\n'),locations,warnings:columns?[`第 ${page} 页按${layout==='columns-right'?'右至左':'左至右'}分栏提取，请核对跨栏/跨页题目。`]:[]};
}
