import {buildPdf,PDF_FONTS} from './pdf-engine';
import type {PdfModel} from './pdf-model';
self.onmessage=async(event:MessageEvent<{model:PdfModel}>)=>{
  try{
    const fonts=Object.fromEntries(await Promise.all(Object.entries(PDF_FONTS).map(async([name,file])=>{const response=await fetch(`/fonts/${file}`,{credentials:'same-origin'});if(!response.ok)throw Error('PDF fonts are unavailable. Reload and retry.');return [name,new Uint8Array(await response.arrayBuffer())];})));
    const data=await buildPdf(event.data.model,fonts,message=>self.postMessage({progress:message}));
    self.postMessage({data,warnings:event.data.model.warnings});
  }catch(error){self.postMessage({error:error instanceof Error?error.message:'PDF renderer unavailable. Reload and retry.'});}
};
