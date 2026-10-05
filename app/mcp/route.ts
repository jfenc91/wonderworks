import {database} from '@/db/runtime';
import {McpStore} from '@/db/mcp-store';
import {handleMcp} from '@/lib/mcp/http';

export const dynamic='force-dynamic';
export function POST(request:Request){return handleMcp(request,new McpStore(database()));}
export function GET(request:Request){return handleMcp(request,new McpStore(database()));}
export function DELETE(request:Request){return handleMcp(request,new McpStore(database()));}
