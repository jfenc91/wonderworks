import test from 'node:test';
import assert from 'node:assert/strict';
import {excerpt} from '../lib/item-preview.ts';
test('preview boundaries keep complete words, combining characters, family emoji and identifiers',()=>{
 for(const value of ['👩🏽‍💻','👨‍👩‍👧‍👦','é','🇫🇷','snake_case','x < y']){
  const input='Complete '+value+' continues after the boundary.';
  for(let limit=1;limit<input.length;limit++){
   const result=excerpt(input,limit);assert.ok(input.startsWith(result.text));
   const boundaries=new Set(Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(input)).map(v=>v.index));boundaries.add(input.length);assert.ok(boundaries.has(result.text.length));
   assert.ok(!/\b(?:Complet|continu|boundar)$/.test(result.text));
  }
 }
 assert.deepEqual(excerpt(' <literal>  \n\tsnake_case ',100),{text:' <literal>  \n\tsnake_case ',truncated:false});
 assert.deepEqual(excerpt('ordinaryword remainder',4),{text:'ordinaryword',truncated:true});
});
