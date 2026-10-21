import { createHash } from 'node:crypto';
import type { SessionEvidence } from './board-recovery-policy.js';
type Session = Record<string, unknown>;
type Identity = { companyId:string; agentId:string; issueId:string };
/** Newest-by-creation label lookup, NOT a saved run/dispatch session column.
 * Read-only and bounded. Incomplete discovery, ambiguous ordering, HTTP errors,
 * wrong ownership, pending input and a busy older duplicate all fail closed.
 * No session, provider or prompt mutations are permitted here. */
export async function probeNewestIssueSession(identity:Identity, config:Record<string,unknown>, request:typeof fetch=fetch):Promise<SessionEvidence|null> {
  const base=config.baseUrl ?? config.url, provider=config.agentId ?? config.omnigentAgentId;
  if(typeof base!=='string' || typeof provider!=='string') return null;
  if(!['http:','https:'].includes(new URL(base).protocol)) return null;
  const headers=new Headers();
  if(config.headers && typeof config.headers==='object') for(const [key,value] of Object.entries(config.headers)) if(typeof value==='string') headers.set(key,value);
  if(typeof config.apiToken==='string') headers.set('Authorization','Bearer '+config.apiToken);
  if(typeof config.hostId==='string') headers.set('X-Databricks-Omnigent-Slice-Key',config.hostId);
  async function get(path:string) {
    const response=await request(String(base).replace(/\/+$/,'')+path,{method:'GET',headers,redirect:'error',signal:AbortSignal.timeout(5000)});
    if(!response.ok) throw Error('OmniGenT issue-session evidence unavailable');
    return await response.json();
  }
  const label=`${identity.companyId}:${identity.agentId}:issue:${identity.issueId}`;
  const owned=(s:Session)=>s.agent_id===provider && (s.labels as Session|undefined)?.['paperclip.issue_key']===label &&
    (s.labels as Session|undefined)?.['paperclip.company_id']===identity.companyId &&
    (s.labels as Session|undefined)?.['paperclip.agent_id']===identity.agentId &&
    (typeof config.hostId!=='string' || s.host_id===config.hostId);
  let after:string|null=null;
  const seen=new Set<string>();
  // Lists are newest first in OmniGenT. Scan all bounded pages to detect older
  // duplicate live work too; an archived historical binding is never selected.
  let newest:Session|null=null, duplicateBusy=false, complete=false;
  for(let page=0;page<10;page++) {
    const params=new URLSearchParams({limit:'100',agent_id:provider,include_archived:'true'});
    if(after) params.set('after',after);
    const response=await get('/v1/sessions?'+params);
    if(!Array.isArray(response.data)) return null;
    for(const s of response.data as Session[]) {
      if(!owned(s)) continue;
      const busy=s.status==='running' || s.active_response_id || nonempty(s.pending_inputs) || nonempty(s.pending_elicitations);
      if(s.archived===true) { if(busy) duplicateBusy=true; continue; }
      if(!newest) newest=s;
      else {
        const created=Date.parse(String(s.created_at ?? '')), selected=Date.parse(String(newest.created_at ?? ''));
        if(Number.isFinite(created) && Number.isFinite(selected) && created>selected) {
          if(newest.status==='running' || newest.active_response_id || nonempty(newest.pending_inputs) || nonempty(newest.pending_elicitations)) duplicateBusy=true;
          newest=s;
        } else if(busy) duplicateBusy=true;
      }
    }
    if(!response.has_more) {complete=true;break;}
    const next=response.data.at(-1)?.id;
    if(typeof next!=='string' || seen.has(next)) return null;
    seen.add(next);after=next;
  }
  if(!complete) return null;
  if(!newest) return {id:'absent',fingerprint:'no-owned-session',idle:!duplicateBusy,absent:true};
  if(typeof newest.id!=='string') return null;
  if(typeof newest.host_id==='string') headers.set('X-Databricks-Omnigent-Slice-Key',newest.host_id);
  const current=await get('/v1/sessions/'+encodeURIComponent(newest.id)+'?include_items=false&include_usage=false') as Session;
  if(current.id!==newest.id || current.host_id!==newest.host_id || !owned(current) || current.archived===true) return null;
  const idle=!duplicateBusy && ['idle','failed','error','errored'].includes(String(current.status)) &&
    !current.active_response_id && !nonempty(current.pending_inputs) && !nonempty(current.pending_elicitations);
  // A stable transcript tail prevents credit for transient idle windows between
  // tool calls or progress messages. Do not use metadata updated_at heartbeats.
  const items=await get('/v1/sessions/'+encodeURIComponent(newest.id)+'/items?limit=1&order=desc');
  if(!Array.isArray(items.data)) return null;
  const fingerprint=createHash('sha256').update(JSON.stringify([current.status,current.active_response_id ?? null,
    current.last_task_error ?? null,items.data[0] ?? null])).digest('hex');
  return {id:newest.id,fingerprint,idle};
}
function nonempty(value:unknown) { return value != null && (!Array.isArray(value) || value.length>0); }
