import { unzipSync, strFromU8 } from 'fflate';
import type { DocumentExtraction } from './document-types';

export interface DocxExtraction extends DocumentExtraction { images: Array<{ marker: string; bytes: Uint8Array; mime: string }> }
const local = (e: Element, name: string) => [...e.getElementsByTagName('*')].filter(n => n.localName === name);
const attr = (e: Element | undefined, name: string) => e?.getAttribute(`w:${name}`) ?? e?.getAttribute(name) ?? '';
export function extractDocxStructure(bytes: Uint8Array, Parser: typeof DOMParser = DOMParser): DocxExtraction {
  let size = 0, count = 0;
  const files = unzipSync(bytes, { filter(file) { size += file.originalSize; count++; if (count > 2000 || file.originalSize > 12_000_000 || size > 40_000_000) throw new Error('DOCX 解压内容过大，请拆分。');
    return /^word\/(document\.xml|numbering\.xml|_rels\/document\.xml\.rels|media\/[^/]+)$/.test(file.name); } });
  const parse = (name: string) => { const raw = strFromU8(files[name] ?? new Uint8Array()); if (/<!DOCTYPE|<!ENTITY/i.test(raw)) throw new Error('DOCX XML 包含不支持的声明。');
    const doc = new Parser().parseFromString(raw || '<empty/>', 'application/xml'); if (doc.querySelector('parsererror')) throw new Error('DOCX XML 无法解析。'); return doc; };
  if (!files['word/document.xml']) throw new Error('请选择有效的 DOCX；旧 DOC 请先另存为 DOCX。');
  const doc = parse('word/document.xml'); const numbering = parse('word/numbering.xml'); const rels = parse('word/_rels/document.xml.rels');
  const warnings: string[] = ['DOCX 为来源结构预览，请对照原文件核对表格、编号和公式。']; const images: DocxExtraction['images'] = []; let objectNumber=0; const abstracts = new Map<string, Map<string,{format:string;start:number}>>();
  for (const node of [...numbering.getElementsByTagName('*')].filter(e => e.localName === 'abstractNum')) {
    const levels = new Map<string,{format:string;start:number}>();
    for (const level of local(node,'lvl')) levels.set(attr(level,'ilvl'), { format: attr(local(level,'numFmt')[0],'val'), start: Number(attr(local(level,'start')[0],'val')) || 1 });
    abstracts.set(attr(node,'abstractNumId'),levels);
  }
  const ids = new Map<string,string>(); for (const node of [...numbering.getElementsByTagName('*')].filter(e => e.localName === 'num')) ids.set(attr(node,'numId'),attr(local(node,'abstractNumId')[0],'val'));
  const counts = new Map<string,number>();
  const targets = new Map([...rels.getElementsByTagName('*')].filter(e=>e.localName==='Relationship' && e.getAttribute('TargetMode')!=='External').map(e=>[e.getAttribute('Id'),e.getAttribute('Target') ?? '']));
  function text(node: Node): string {
    if (node.nodeType === 3) return '';
    if (node.nodeType !== 1) return ''; const e=node as Element;
    if (e.localName === 't') return e.textContent ?? '';
    if (e.localName === 'br' || e.localName === 'cr') return '\n'; if (e.localName === 'tab') return '\t';
    if (['pPr','rPr','instrText','del','delText'].includes(e.localName)) return '';
    if (e.namespaceURI?.includes('officeDocument/2006/math') && ['rad','nary','d','eqArr','matrix','m','sSubSup','bar','acc','groupChr','limLow','limUpp','func','phant','borderBox','box'].includes(e.localName)) {
      warnings.push('含不支持的复杂公式，必须对照原文转写占位内容。'); return `〔公式待校对${++objectNumber}〕`;
    }
    if (e.localName === 'drawing' || e.localName === 'pict' || e.localName === 'object') {
      const id = local(e,'blip')[0]?.getAttribute('r:embed'); const target=targets.get(id ?? ''); const extension=target?.split('.').at(-1)?.toLowerCase();
      const marker=`〔图片或对象待校对${++objectNumber}〕`;
      if (target && /^media\/[^/\\]+$/.test(target) && files[`word/${target}`] && ['png','jpg','jpeg','webp'].includes(extension ?? '')) images.push({marker,bytes:files[`word/${target}`],mime:`image/${extension==='jpg'?'jpeg':extension}`});
      else warnings.push('含无法提取的图片或嵌入对象，需在原文件核对并转写。'); return marker;
    }
    const children = () => [...e.childNodes].map(text).join('');
    if (e.localName === 'f') return `(${local(e,'num').map(childrenText).join('')})/(${local(e,'den').map(childrenText).join('')})`;
    if (e.localName === 'sSup' || e.localName === 'sSub') return `${childrenText([...e.children].find(n=>n.localName==='e')!)}${e.localName==='sSup'?'^':'_'}(${childrenText([...e.children].find(n=>['sup','sub'].includes(n.localName))!)})`;
    if (e.localName === 'r') {
      const val=attr(local(e,'vertAlign')[0],'val'); const value=children(); return val==='superscript'?`^(${value})`:val==='subscript'?`_(${value})`:value;
    }
    if (e.localName === 'p') {
      const prop=local(e,'numPr')[0]; let prefix='';
      if (prop) { const id=attr(local(prop,'numId')[0],'val'), level=attr(local(prop,'ilvl')[0],'val')||'0'; const info=abstracts.get(ids.get(id) ?? '')?.get(level); const key=`${id}:${level}`;
        warnings.push('基本自动编号已重建；多级、重启编号与自定义标识请对照原文校对。');
        if(info && !['decimal','upperLetter','lowerLetter','bullet'].includes(info.format))warnings.push('编号样式已转为阿拉伯数字，请人工核对。');
        if (info) { const n=counts.get(key) ?? info.start; counts.set(key,n+1); prefix=info.format==='upperLetter'?`${String.fromCharCode(65+(n-1)%26)}. `:info.format==='lowerLetter'?`${String.fromCharCode(97+(n-1)%26)}. `:info.format==='bullet'?'• ':`${n}. `; }
        else warnings.push('有未能确定的自动编号，请核对选项标识。');
      }
      return prefix+children()+'\n';
    }
    return children();
  }
  function childrenText(e: Element | undefined) { return e ? [...e.childNodes].map(text).join('') : ''; }
  const body = [...doc.getElementsByTagName('*')].find(e=>e.localName==='body'); if(!body)throw new Error('DOCX 缺少正文。');
  const blocks:string[]=[];const outside:string[]=[];const source:string[]=[];
  for(const child of [...body.children]) {
    if(child.localName==='tbl') {
      const rows=[...child.children].filter(e=>e.localName==='tr').map(row=>[...row.children].filter(e=>e.localName==='tc').map(cell=>childrenText(cell).trim()));
      source.push(rows.map(row=>row.join(' | ')).join('\n'));
      const headers=rows[0]?.map(cell=>cell.replace(/[：:\s]/g,''))??[];
      if(['题型','题干','答案'].every(h=>headers.includes(h))) {
        for(const row of rows.slice(1)) { if(!row.some(Boolean))continue; const data=new Map(headers.map((h,i)=>[h,row[i]??'']));
          blocks.push(['【题目】',`编号：${data.get('编号')||blocks.length+1}`,`题型：${data.get('题型')}`, ...(data.get('空数')?[`空数：${data.get('空数')}`]:[]), `题干：${data.get('题干')}`, ...(data.get('选项')?['选项：',data.get('选项')!]:[]),`答案：${data.get('答案')}`, ...(data.get('解析')?[`解析：${data.get('解析')}`]:[]),'【结束】'].join('\n')); }
      } else if(['题型','题干','答案'].every(h=>rows.some(row=>row[0]?.replace(/[：:\s]/g,'')===h))) {
        blocks.push(['【题目】',...rows.map(row=>`${row[0].replace(/[：:\s]/g,'')}：${row.slice(1).join('\n')}`),'【结束】'].join('\n'));
      } else { outside.push(rows.map(row=>row.join('\t')).join('\n')); warnings.push('表格未匹配题库字段，请按来源结构整理固定格式。'); }
    } else { const value=text(child).trim();if(value){outside.push(value);source.push(value);} }
  }
  if(images.length)warnings.push('含正文图片，可选择 OCR；识别后仍需核对题面、数字与公式。');
  if(doc.getElementsByTagNameNS('*','oMath').length)warnings.push('公式按可读取结构转换，请对照原文件核对。');
  const name=outside.find(p=>p.startsWith('题库名称：'))?.slice(5).trim()||'文档导入题库';
  const result=blocks.length?`题库格式：CXQB-1\n题库名称：${name}\n题目总数：${blocks.length}\n\n${blocks.join('\n\n')}`:outside.join('\n');
  if(blocks.length && outside.some(p=>!/^题库(?:名称|格式)|^题目总数/.test(p)))warnings.push('表格外正文已保留在来源预览，请核对是否有需补入的题目。');
  if(result.length>6_000_000)throw new Error('提取内容超过 600 万字符，请拆分文档。');
  return {text:result,locations:result.split('\n').map((_,i)=>`DOCX 提取第 ${i+1} 行`),warnings:[...new Set(warnings)],previews:[{label:'DOCX 来源结构',text:source.join('\n\n')}],images};
}
