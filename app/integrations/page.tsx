'use client';
import {useState} from 'react';
import {Sparkles,Copy,Check,Plug,FileText,GitPullRequest,ShieldCheck} from 'lucide-react';

export default function Integrations(){
  const [copied,setCopied]=useState(false),[error,setError]=useState('');
  async function copy(){try{await navigator.clipboard.writeText(new URL('/mcp',window.location.origin).href);setCopied(true);setError('');}catch{setError('Copy the address from your browser and add /mcp.');}}
  return <main className="connection-page">
    <a className="brand" href="/"><Sparkles size={26}/><strong>wonderworks</strong></a>
    <div className="eyebrow"><Plug size={16}/> ASSISTANT CONNECTION</div>
    <h1>Bring your requirements<br/>into the conversation.</h1>
    <p className="connection-intro">Connect Wonderworks to an assistant to read specifications, propose changes, and bring verification results back to the right snapshot.</p>
    <div className="connection-grid"><section className="connection-card">
      <h2>Connect the Wonderworks plugin</h2>
      <ol><li>In Codex or ChatGPT, open <strong>Plugins → Personal → Created by you</strong> and select Wonderworks.</li><li>Choose <strong>Install</strong> or <strong>Connect</strong>, then authorize with the account that has access to this Site.</li><li>Ask your assistant: <em>“List my Wonderworks projects and read the requirements for Wonderworks.”</em></li></ol>
      <p>Your assistant can keep working after you close this browser tab. It uses the same saved project data.</p>
      <button className="secondary" onClick={()=>void copy()}>{copied?<Check size={16}/>:<Copy size={16}/>} {copied?'MCP address copied':'Copy MCP address'}</button>
      {error&&<p role="alert">{error}</p>}
    </section><section className="connection-card">
      <h2>What the connection can do</h2>
      <p><FileText size={18}/> Read requirements, snapshots, repository links, proposals, and evidence.</p>
      <p><GitPullRequest size={18}/> Draft and submit requirement changes. Apply, reject, or request changes in Wonderworks.</p>
      <p><ShieldCheck size={18}/> Record test results against an existing snapshot, including failures.</p>
      <p>Access follows this Site’s sharing settings. To disconnect, open the plugin’s settings in your assistant and revoke its connection.</p>
    </section></div>
    <details className="connection-card"><summary>Connection details</summary><p>The endpoint is this Site’s address followed by <code>/mcp</code>. The Site plugin supplies the correct OAuth resource and hosted sign-in flow automatically.</p><p>Transport: Streamable HTTP. Supported protocol revisions: 2025-11-25, 2025-06-18, and 2025-03-26. There are 16 tools; every project operation requires an explicit project ID.</p><p>Writes require the last-read workspace version and an idempotency key. Retry an uncertain write with identical arguments and the same key within 24 hours. After that window, inspect the saved proposal or evidence before trying again.</p></details>
    <a className="secondary" href="/">Return to requirements</a>
  </main>;
}
