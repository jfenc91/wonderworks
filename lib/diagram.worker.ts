import dagre from '@dagrejs/dagre';
import {instance} from '@viz-js/viz';
import {parseMermaid,validateDot,DIAGRAM_LIMITS,type DiagramGraph} from './diagrams';
import type {DiagramBlock} from './types';
const esc=(s:unknown)=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const text=(x:number,y:number,label:string)=>`<text x="${x}" y="${y}" text-anchor="middle" fill="#172129" font-size="14" font-family="sans-serif">${esc(label)}</text>`;
function graphSvg(g:DiagramGraph){
 let width=0,height=0,body='';
 if(g.type==='sequence'){
  width=Math.max(400,g.nodes.length*220);height=140+g.edges.length*75;
  const pos=(id:string)=>g.nodes.findIndex(n=>n.id===id)*220+110;
  for(const n of g.nodes){const x=pos(n.id);body+=`<rect x="${x-95}" y="10" width="190" height="44" rx="5" fill="#f8e0c9" stroke="#5d4d3f"/>${text(x,37,n.label)}<path d="M${x},54 V${height-20}" stroke="#86929c" stroke-dasharray="5 5"/>`;}
  g.edges.forEach((e,i)=>{const x=pos(e.from),end=pos(e.to),y=95+i*75;body+=`<path d="M${x},${y} ${x===end?`h55 v28 h-55`:`H${end}`}" fill="none" stroke="#364653" stroke-width="${e.thick?3:1.5}" ${e.dashed?'stroke-dasharray="5 4"':''} marker-end="url(#arrow)"/>${text((x+end)/2+(x===end?55:0),y-12,e.label)}`;});
 }else{
  const graph=new dagre.graphlib.Graph({multigraph:true,compound:true});graph.setGraph({rankdir:g.direction,marginx:30,marginy:30,nodesep:40,ranksep:70});graph.setDefaultEdgeLabel(()=>({}));
  for(const group of g.groups)graph.setNode('group-'+group.id,{label:group.label});
  for(const n of g.nodes){graph.setNode(n.id,{width:Math.min(500,Math.max(110,n.label.length*8+30)),height:n.shape==='diamond'?80:48});if(n.group)graph.setParent(n.id,'group-'+n.group);}
  g.edges.forEach((e,i)=>graph.setEdge(e.from,e.to,{width:e.label.length*7,height:e.label?22:0},String(i)));dagre.layout(graph);width=graph.graph().width??400;height=graph.graph().height??300;
  for(const group of g.groups){const n=graph.node('group-'+group.id);body+=`<rect x="${n.x-n.width/2}" y="${n.y-n.height/2}" width="${n.width}" height="${n.height}" rx="8" fill="#f6f1e9" stroke="#a5a097"/>${text(n.x,n.y-n.height/2+20,group.label)}`;}
  g.edges.forEach((e,i)=>{const edge=graph.edge({v:e.from,w:e.to,name:String(i)});body+=`<path d="${edge.points.map((p:{x:number;y:number},i:number)=>`${i?'L':'M'}${p.x},${p.y}`).join(' ')}" fill="none" stroke="#364653" stroke-width="${e.thick?3:1.5}" ${e.dashed?'stroke-dasharray="5 4"':''} ${e.directed===false?'':'marker-end="url(#arrow)"'}/>${e.label?text(edge.x,edge.y-4,e.label):''}`;});
  for(const n of g.nodes){const p=graph.node(n.id);body+=n.shape==='ellipse'?`<ellipse cx="${p.x}" cy="${p.y}" rx="${p.width/2}" ry="${p.height/2}" fill="#f8e0c9" stroke="#5d4d3f"/>`:n.shape==='diamond'?`<polygon points="${p.x},${p.y-p.height/2} ${p.x+p.width/2},${p.y} ${p.x},${p.y+p.height/2} ${p.x-p.width/2},${p.y}" fill="#f8e0c9" stroke="#5d4d3f"/>`:`<rect x="${p.x-p.width/2}" y="${p.y-p.height/2}" width="${p.width}" height="${p.height}" rx="5" fill="#f8e0c9" stroke="#5d4d3f"/>`;body+=text(p.x,p.y+5,n.label);}
 }
 if(width>24000||height>24000)throw Error('Generated diagram dimensions exceed 24000 pixels');
 return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#364653"/></marker></defs>${body}</svg>`;
}
self.onmessage=async(event:MessageEvent<DiagramBlock>)=>{try{const d=event.data;let svg:string;if(d.language==='mermaid')svg=graphSvg(parseMermaid(d.source));else{validateDot(d.source);const viz=await instance();svg=viz.renderString(d.source,{format:'svg',engine:'dot'});}if(svg.length>DIAGRAM_LIMITS.output)throw Error('Generated diagram exceeds output limit');self.postMessage({svg});}catch(e){self.postMessage({error:(e as Error).message});}};
