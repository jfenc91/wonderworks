// Shared by the browser, backup CLI and importer. A successful HTTP response
// can still contain only a prefix of a streamed ZIP, even at an entry boundary.
export const ARCHIVE_TAIL_BYTES=2*1024*1024;
const incomplete='Incomplete workspace archive. Download it again.';

/** @param {Uint8Array} tail @param {number} total @param {Map<string,string>} [files] */
export function validateArchiveDirectory(tail,total,files){
  const view=new DataView(tail.buffer,tail.byteOffset,tail.byteLength),u16=o=>view.getUint16(o,true),u32=o=>view.getUint32(o,true);
  const end=tail.length-22;
  if(end<0||u32(end)!==0x06054b50||u16(end+4)!==0||u16(end+6)!==0||u16(end+20)!==0||u16(end+8)!==u16(end+10)||u16(end+10)<1||u16(end+10)>10001||files&&u16(end+10)!==files.size||u32(end+12)>ARCHIVE_TAIL_BYTES-22||u32(end+16)+u32(end+12)+22!==total)throw Error(incomplete);
  const directory=u32(end+16);let offset=directory-(total-tail.length);
  const names=new Set();
  for(let i=0;i<u16(end+10);i++){
    if(offset<0||offset+46>end||u32(offset)!==0x02014b50||u16(offset+8)&~0x0808||![0,8].includes(u16(offset+10))||u16(offset+34)!==0)throw Error(incomplete);
    const length=u16(offset+28),extra=u16(offset+30),comment=u16(offset+32),next=offset+46+length+extra+comment;
    if(next>end||extra||comment)throw Error(incomplete);
    const name=new TextDecoder('utf-8',{fatal:true}).decode(tail.subarray(offset+46,offset+46+length));
    if(names.has(name)||name!=='manifest.json'&&!/^records\/[a-f0-9]{64}\.json$/.test(name)||u32(offset+42)+30+length+u32(offset+20)>directory||u32(offset+24)>(name==='manifest.json'?2*1024*1024:65536)||files&&(!files.has(name)||u32(offset+24)!==new TextEncoder().encode(files.get(name)).length))throw Error(incomplete);
    names.add(name);offset=next;
  }
  if(offset!==end||!names.has('manifest.json'))throw Error(incomplete);
}

/** Check container completion without inflating or materializing the workspace.
 * Full manifest, checksum and relationship validation remains mandatory on import.
 * @param {Blob} blob @param {AbortSignal} [signal]
 */
export async function validateArchiveDownload(blob,signal){
  if(blob.size>32*1024*1024)throw Error('Archive exceeds 32 MiB.');
  signal?.throwIfAborted();
  const tail=new Uint8Array(await blob.slice(-ARCHIVE_TAIL_BYTES).arrayBuffer());
  signal?.throwIfAborted();
  validateArchiveDirectory(tail,blob.size);
}
