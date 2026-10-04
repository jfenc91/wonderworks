import {env} from 'cloudflare:workers';
import {McpStore} from '@/db/mcp-store';
import {handleMcp} from '@/lib/mcp/http';

export const dynamic='force-dynamic';
export function POST(request:Request){return handleMcp(request,new McpStore(env.DB));}
export function GET(request:Request){return handleMcp(request,new McpStore(env.DB));}
export function DELETE(request:Request){return handleMcp(request,new McpStore(env.DB));}
