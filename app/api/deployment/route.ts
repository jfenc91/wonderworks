import {deployment} from '@/db/runtime';
import {tools} from '@/lib/mcp/contracts';
import {PROTOCOL_VERSIONS} from '@/lib/mcp/http';
export const dynamic='force-dynamic';
export function GET(request:Request){const d=deployment();return Response.json({...d,mcpUrl:new URL('/mcp',d.baseUrl??new URL(request.url).origin).href,protocols:PROTOCOL_VERSIONS,toolCount:tools.length},{headers:{'Cache-Control':'no-store'}});}
