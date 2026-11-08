import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { JSDOM } from 'jsdom';
import { extractDocxStructure } from '../src/features/local-question-bank/docx-structure';
import { cropPercent, selectedPages } from '../src/features/local-question-bank/document-types';
import { reconstructPdfLayout } from '../src/features/local-question-bank/pdf-layout';
import { hasUnresolvedDocumentContent } from '../src/features/local-question-bank/document-review';
import { parseBankTemplate } from '../src/features/local-question-bank/template';
import type { PdfTextItem } from '../src/features/local-question-bank/file-extract';

const Parser = new JSDOM().window.DOMParser as typeof DOMParser;
const p = (value: string) => `<w:p><w:r><w:t>${value}</w:t></w:r></w:p>`;
const docx = (body: string, more: Record<string, Uint8Array> = {}) => zipSync({
  'word/document.xml': strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body>${body}</w:body></w:document>`), ...more,
});
const row = (cells: string[]) => `<w:tr>${cells.map(value => `<w:tc>${p(value)}</w:tc>`).join('')}</w:tr>`;

test('DOCX field table becomes a complete template and preserves Unicode and source text', () => {
  const result = extractDocxStructure(docx(p('题库名称：表格题库') + `<w:tbl>${row(['题型','题干','选项','答案','解析'])}${row(['单选','x ≤ 3 时，哪项不成立？','A. x &lt; 4\nB. x &gt; 5','B','否定条件必须保留'])}</w:tbl>`), Parser);
  const draft = parseBankTemplate(result.text, result.locations);
  assert.deepEqual(draft.issues, []); assert.equal(draft.name, '表格题库'); assert.equal(draft.items.length, 1);
  assert.equal(draft.items[0].record.question.stem, 'x ≤ 3 时，哪项不成立？');
  assert.deepEqual(draft.items[0].record.answer.choices, ['option-B']);
  assert.match(result.previews[0].text, /题型 \| 题干/); assert.ok(result.warnings.length);
});

test('DOCX simple numbering, superscript and fractions are explicit; complex formulas and objects remain blocked', () => {
  const numbering = strToU8('<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="upperLetter"/></w:lvl></w:abstractNum><w:num w:numId="5"><w:abstractNumId w:val="0"/></w:num></w:numbering>');
  const numbered = (text: string) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const result = extractDocxStructure(docx(numbered('第一项') + numbered('第二项') + '<w:p><w:r><w:t>x</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>2</w:t></w:r><m:oMath><m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>3</m:t></m:r></m:den></m:f><m:rad><m:e><m:r><m:t>x</m:t></m:r></m:e></m:rad></m:oMath><w:r><w:object/></w:r></w:p>', {'word/numbering.xml': numbering}), Parser);
  assert.match(result.text, /^A\. 第一项\nB\. 第二项\nx\^\(2\)\(1\)\/\(3\)/);
  assert.ok(hasUnresolvedDocumentContent(result.text)); assert.match(result.text, /〔公式待校对1〕.*〔图片或对象待校对2〕/);
  assert.ok(result.warnings.some(w => w.includes('复杂公式')));
  assert.equal(hasUnresolvedDocumentContent('x^(2) + (1)/(3)'), false);
});

test('DOCX rejects malformed/entity XML and decompression bombs, without loading external images', () => {
  for (const xml of ['<broken>', '<!DOCTYPE x [<!ENTITY xx SYSTEM "https://invalid.test">]><x>&xx;</x>']) {
    assert.throws(() => extractDocxStructure(zipSync({'word/document.xml':strToU8(xml)}), Parser), /XML/);
  }
  assert.throws(() => extractDocxStructure(docx(p('ok'), {'word/media/huge.png': new Uint8Array(12_000_001)}), Parser), /过大/);
  const result = extractDocxStructure(docx('<w:p><w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r></w:p>', {
    'word/_rels/document.xml.rels':strToU8('<Relationships><Relationship Id="rId1" TargetMode="External" Target="https://invalid.test/image.png"/></Relationships>'),
  }), Parser);
  assert.equal(result.images.length, 0); assert.ok(hasUnresolvedDocumentContent(result.text));
});

test('PDF page ranges and crop bounds reject silent omissions and oversized OCR queues', () => {
  assert.deepEqual(selectedPages('1-3,2,8', 10), [1,2,3,8]); assert.deepEqual(selectedPages('', 2), [1,2]);
  for (const value of ['0','3-2','1-11','1,,2','NaN']) assert.throws(() => selectedPages(value,10));
  assert.throws(() => selectedPages('',21,20), /20/); assert.throws(() => selectedPages('1',201), /200/);
  assert.deepEqual(cropPercent('0,8,100,84'), [0,8,100,84]); assert.deepEqual(cropPercent(''),[0,0,100,100]);
  for (const value of ['0,0,101,100','-1,0,80,80','0,0,0,90','0,0,80','0,0,NaN,90']) assert.throws(() => cropPercent(value));
});

test('PDF column order keeps conditions and labels; unreadable and rotated runs require OCR', () => {
  const item = (str: string,x: number,y:number): PdfTextItem => ({str,width:80,height:12,transform:[12,0,0,12,x,y]});
  const items = [item('题干：x ≠ 10',40,700),item('A. x ≤ 3',40,680),item('B. x > 5',40,660),item('答案：B',340,700),item('解析：不能省略否定',340,680),item('【结束】',340,660)];
  const normal = reconstructPdfLayout(items,600,2,'columns'); const reversed = reconstructPdfLayout(items,600,2,'columns-right');
  assert.equal(normal.text.split('\n')[3],'答案：B'); assert.equal(reversed.text.split('\n')[0],'答案：B');
  assert.equal(normal.locations[3],'PDF 第 2 页第 2 栏第 1 行'); assert.equal(normal.warnings.length,1);
  assert.equal(reconstructPdfLayout(items,600,2,'rows').text.split('\n').length,3);
  assert.throws(() => reconstructPdfLayout([item('\uFFFD',40,700)],600,1,'auto'), /OCR/);
  const rotated = item('x',40,700); rotated.transform = [0,12,-12,0,40,700];
  assert.throws(() => reconstructPdfLayout([rotated],600,1,'auto'), /OCR/);
});
