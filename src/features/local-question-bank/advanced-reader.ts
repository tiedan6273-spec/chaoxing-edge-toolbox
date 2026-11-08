import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { extractDocxStructure } from './docx-structure';
import { reconstructPdfLayout } from './pdf-layout';
import type { PdfTextItem } from './file-extract';
import { cropPercent, selectedPages, type DocumentExtraction, type ImportOptions, type SourcePreview } from './document-types';
import { createOcrSession } from './ocr-client';

const abortError=()=>new DOMException('已取消读取，未导入题库。','AbortError');
export async function readAdvancedDocument(file:File,options:ImportOptions,signal:AbortSignal,progress:(text:string)=>void):Promise<DocumentExtraction> {
  const check=()=>{if(signal.aborted)throw abortError();};check();
  if(!file.size||file.size>20*1024*1024)throw new Error('文档/图片应为不超过 20 MB 的文件。');
  const crop=cropPercent(options.crop);let session:ReturnType<typeof createOcrSession>|undefined;
  const warnings:string[]=[];const previews:SourcePreview[]=[];let ocrPages=0;
  async function ocr(canvas:HTMLCanvasElement,label:string,pdfLayout=false){
    check();if(++ocrPages>20)throw new Error('本轮 OCR 最多 20 页或图片，请选择页码范围后分批读取。');
    progress(`正在本机识别 ${label}…`);session??=createOcrSession(options.language,signal,progress);
    const columns=pdfLayout&&(options.layout==='columns'||options.layout==='columns-right');
    const order=columns?(options.layout==='columns-right'?[1,0]:[0,1]):[0]; const texts:string[]=[];
    for(const column of order){
      check();let region=canvas;
      if(columns){region=document.createElement('canvas');const start=Math.floor(column*canvas.width/2),end=Math.floor((column+1)*canvas.width/2);region.width=end-start;region.height=canvas.height;region.getContext('2d')!.drawImage(canvas,start,0,region.width,region.height,0,0,region.width,region.height);}
      try{
        const result=await session.recognize(region,columns||pdfLayout&&options.layout==='rows');check();
        if(!result.text.trim())throw new Error(`${label}${columns?`第 ${column+1} 栏`:''} 未识别到文字，请检查原图或选择其他区域。`);
        warnings.push(`${label}${columns?`第 ${column+1} 栏`:''} OCR 识别置信度 ${Math.round(result.confidence)}，这不是答案正确率；需核对文字、数字和公式。`);
        texts.push(result.text.replace(/\r\n?/g,'\n').trimEnd());
      }finally{if(region!==canvas)region.width=region.height=0;}
    }
    if(columns)warnings.push(`${label} 按页面中线分栏，${options.layout==='columns-right'?'先右后左':'先左后右'}；请核对跨栏内容。`);
    return texts.join('\n');
  }
  function thumb(canvas:HTMLCanvasElement){const preview=document.createElement('canvas');const scale=Math.min(1,700/canvas.width);preview.width=Math.max(1,Math.round(canvas.width*scale));preview.height=Math.max(1,Math.round(canvas.height*scale));preview.getContext('2d')!.drawImage(canvas,0,0,preview.width,preview.height);const data=preview.toDataURL('image/jpeg',.72);preview.width=preview.height=0;return data;}
  function cropCanvas(source:HTMLCanvasElement){const canvas=document.createElement('canvas');const [x,y,w,h]=crop.map(n=>n/100);const scale=Math.min(1,Math.sqrt(10_000_000/(source.width*w*source.height*h)));
    canvas.width=Math.max(1,Math.floor(source.width*w*scale));canvas.height=Math.max(1,Math.floor(source.height*h*scale));canvas.getContext('2d')!.drawImage(source,source.width*x,source.height*y,source.width*w,source.height*h,0,0,canvas.width,canvas.height);return canvas;}
  async function imageCanvas(blob:Blob){check();const image=await createImageBitmap(blob);try{if(image.width*image.height>40_000_000)throw new Error('原图超过 4000 万像素，请先缩小。');const canvas=document.createElement('canvas');const scale=Math.min(1,Math.sqrt(10_000_000/(image.width*image.height)));canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));canvas.getContext('2d')!.drawImage(image,0,0,canvas.width,canvas.height);return canvas;}finally{image.close();}}
  async function render(page:PDFPageProxy){const base=page.getViewport({scale:1});const scale=Math.min(2.5,Math.sqrt(10_000_000/(base.width*base.height)));const viewport=page.getViewport({scale});
    const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);const task=page.render({canvas,canvasContext:canvas.getContext('2d')!,viewport});const cancel=()=>task.cancel();signal.addEventListener('abort',cancel,{once:true});
    try{await task.promise;check();return canvas;}catch(e){canvas.width=canvas.height=0;check();throw e;}finally{signal.removeEventListener('abort',cancel);}}
  try{
    const extension=file.name.split('.').at(-1)?.toLowerCase();
    if(['png','jpg','jpeg','webp'].includes(extension??'')){
      const source=await imageCanvas(file);const canvas=cropCanvas(source);source.width=source.height=0;
      try{const text=await ocr(canvas,'图片');previews.push({label:'图片来源',text,image:thumb(canvas)});return{text,locations:text.split('\n').map((_,i)=>`OCR 第 ${i+1} 行`),warnings,previews};}finally{canvas.width=canvas.height=0;}
    }
    if(extension==='docx'){
      const result=extractDocxStructure(new Uint8Array(await file.arrayBuffer()));check();
      if(result.images.length&&options.mode==='ocr')for(const image of result.images){
        const source=await imageCanvas(new Blob([new Uint8Array(image.bytes).buffer],{type:image.mime}));const canvas=cropCanvas(source);source.width=source.height=0;
        try{const text=await ocr(canvas,image.marker);result.text=result.text.split(image.marker).join(text);previews.push({label:image.marker,text,image:thumb(canvas)});}finally{canvas.width=canvas.height=0;}
      }
      return{text:result.text,locations:result.text.split('\n').map((_,i)=>`DOCX 整理第 ${i+1} 行`),warnings:[...result.warnings,...warnings],previews:[...result.previews,...previews]};
    }
    if(extension!=='pdf')throw new Error('增强导入支持 DOCX、PDF、PNG、JPG 和 WebP；旧 DOC 请先转换。');
    const pdfjs=await import(chrome.runtime.getURL('vendor/pdf.mjs')) as typeof import('pdfjs-dist');check();pdfjs.GlobalWorkerOptions.workerSrc=chrome.runtime.getURL('vendor/pdf.worker.mjs');
    const pdfBytes=new Uint8Array(await file.arrayBuffer());check();
    const task=pdfjs.getDocument({data:pdfBytes,useWasm:false,cMapUrl:chrome.runtime.getURL('vendor/cmaps/'),cMapPacked:true,standardFontDataUrl:chrome.runtime.getURL('vendor/standard_fonts/'),stopAtErrors:true});
    const cancelPdf=()=>{void task.destroy();};signal.addEventListener('abort',cancelPdf,{once:true});let pdf:PDFDocumentProxy|undefined;
    try{
      pdf=await task.promise;const pages=selectedPages(options.pages,pdf.numPages,options.mode==='ocr'?20:200);const texts:string[]=[];const locations:string[]=[];
      for(const n of pages){check();progress(`正在读取 PDF 第 ${n} 页（${pages.indexOf(n)+1}/${pages.length}）…`);const page=await pdf.getPage(n);
        try{
          const content=await page.getTextContent();check();const viewport=page.getViewport({scale:1});
          if(options.mode!=='ocr'&&page.rotate%360)throw new Error(`PDF 第 ${n} 页有页面旋转，请选择 OCR 后读取。`);
          const all=content.items.filter((item):item is typeof item & PdfTextItem=>'str' in item).map(item=>{
            const [x,y]=viewport.convertToViewportPoint(item.transform[4],item.transform[5]);return {...item,transform:[item.transform[0],item.transform[1],item.transform[2],item.transform[3],x,viewport.height-y]};
          });
          const filtered=all.filter(i=>{const x=(i.transform[4]+i.width/2)/viewport.width*100,y=(viewport.height-i.transform[5])/viewport.height*100;return x>=crop[0]&&x<=crop[0]+crop[2]&&y>=crop[1]&&y<=crop[1]+crop[3];});
          const ops=await page.getOperatorList();const imageOps=new Set(Object.entries(pdfjs.OPS).filter(([name])=>/^paint.*Image/.test(name)).map(([,v])=>v));const hasImages=ops.fnArray.some(op=>imageOps.has(op));
          let text='';let pageLocations:string[]=[];let canvas:HTMLCanvasElement|undefined;
          try{
            if(options.mode==='ocr') {const source=await render(page);canvas=cropCanvas(source);source.width=source.height=0;text=await ocr(canvas,`PDF 第 ${n} 页`,true);pageLocations=text.split('\n').map((_,i)=>`PDF OCR 第 ${n} 页第 ${i+1} 行`);}
            else{
              if(hasImages||!all.some(i=>i.str.trim())&&ops.fnArray.length)throw new Error(`PDF 第 ${n} 页含图片/扫描内容，请将读取方式切换为 OCR。未静默跳过该页。`);
              if(!filtered.some(i=>i.str.trim())&&ops.fnArray.length)throw new Error(`PDF 第 ${n} 页选定区域没有文字，请调整范围或使用 OCR。`);
              const result=reconstructPdfLayout(filtered,viewport.width,n,options.layout);text=result.text;pageLocations=result.locations;warnings.push(...result.warnings);
              if(previews.length<20){const source=await render(page);canvas=cropCanvas(source);source.width=source.height=0;}
            }
            texts.push(text);locations.push(...pageLocations);if(previews.length<20)previews.push({label:`PDF 第 ${n} 页`,text,...(canvas?{image:thumb(canvas)}:{})});
          }finally{if(canvas)canvas.width=canvas.height=0;}
          if(texts.reduce((sum,t)=>sum+t.length,0)>6_000_000)throw new Error('提取内容超过 6 MB，请缩小页码范围。');
        }finally{page.cleanup();}
      }
      warnings.push(`只读取所选的 ${pages.length} 页；请核对页码、跨页题目和阅读顺序。`);
      if(pages.length>20)warnings.push('来源缩略图仅展示前 20 页，完整提取文本保留。');
      return{text:texts.join('\n'),locations,warnings,previews};
    }finally{signal.removeEventListener('abort',cancelPdf);await task.destroy();}
  }catch(e){check();throw e;}finally{session?.close();}
}
