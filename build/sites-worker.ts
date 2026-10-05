import handler from "vinext/server/fetch-handler";
import {runWithDatabase} from '../db/runtime';
import { runWithConnectorBinding } from "../lib/connector-context";
import type { ConnectorBinding } from "../lib/connector-contract.mjs";
const readyBindings=new WeakSet<D1Database>();

export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>) {
    if(!env.DB)return new Response('Database binding unavailable',{status:503});
    if(!readyBindings.has(env.DB)){
      try{
        const schema=await env.DB.prepare('SELECT version FROM wonderworks_schema ORDER BY version DESC LIMIT 1').first<{version:number}>();
        if(schema?.version!==4)throw Error();
        await env.DB.batch([
          env.DB.prepare('SELECT key,actor,fingerprint,result,created_at FROM workspace_imports LIMIT 0'),
          env.DB.prepare('SELECT project,data FROM workspace_provenance LIMIT 0'),
          env.DB.prepare('SELECT id,data FROM workspaces LIMIT 0'),
        ]);
        readyBindings.add(env.DB);
      }
      catch{return new Response('Database requires the matching schema migration. Retry after setup.',{status:503,headers:{'Cache-Control':'no-store'}});}
    }
    let binding = ctx.props?.CONNECTORS;
    // Local preview emulates the same request-scoped capability. This branch and
    // the auxiliary service binding are absent from production builds.
    if (import.meta.env.DEV && !binding && env.CONNECTORS) {
      const preview = env.CONNECTORS;
      const expiresAt = Date.now() + 60_000;
      binding = {
        async getContext() {
          if (Date.now() >= expiresAt) return { status: "request_context_expired" };
          return preview.getContext?.() ?? { status: "binding_unavailable" };
        },
        async invoke(connectorId, actionName, args) {
          if (Date.now() >= expiresAt) {
            return { status: "request_context_expired", message: "This request has expired. Please try again." };
          }
          return preview.invoke(connectorId, actionName, args);
        },
      };
    }
    return runWithDatabase(env.DB,()=>runWithConnectorBinding(binding, () => handler.fetch(request, env, ctx)));
  },
};
