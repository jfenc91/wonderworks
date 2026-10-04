/** Truncate only at complete Unicode word boundaries (including grapheme clusters).
 * A single long identifier stays whole; CSS wraps it inside its card. */
export function excerpt(text:string,limit=240){
 const segments=Array.from(new Intl.Segmenter(undefined,{granularity:'word'}).segment(text));
 let end=0;
 for(const s of segments){
  const next=s.index+s.segment.length;
  if(Array.from(text.slice(0,next)).length>limit){if(!end)end=next;break;}
  end=next;
 }
 return {text:text.slice(0,end),truncated:end<text.length};
}
