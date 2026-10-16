import { validOmnigentReceipt } from './omnigent-attachment.js';
import type { heartbeatRuns } from '@paperclipai/db';
type Run = typeof heartbeatRuns.$inferSelect;
/** Read-only evidence, never stop/terminal/retry authority. No response body or credentials are logged. */
export async function probeOmnigentAdmission(run: Run, config: Record<string, unknown>, request: typeof fetch = fetch): Promise<'not_found' | 'runner_offline' | null> {
 const receipt = run.resultJson?.omnigentDispatchReceipt as Record<string, unknown> | undefined;
 if (!validOmnigentReceipt(run,receipt)) return null;
 const base = config.baseUrl ?? config.url, providerAgent = config.agentId ?? config.omnigentAgentId;
 if (typeof base !== 'string' || typeof providerAgent !== 'string') return null;
 const url = new URL(base); if (!['http:','https:'].includes(url.protocol)) return null;
 const headers = new Headers();
 if(config.headers && typeof config.headers === 'object') for(const [k,v] of Object.entries(config.headers)) if(typeof v==='string')headers.set(k,v);
 if(typeof config.apiToken==='string')headers.set('Authorization','Bearer '+config.apiToken);
 const host = receipt?.omnigentHostId ?? config.hostId;
 if(typeof host==='string')headers.set('X-Databricks-Omnigent-Slice-Key',host);
 const sid=receipt!.omnigentSessionId as string;
 const response=await request(base.replace(/\/+$/,'')+'/v1/sessions/'+encodeURIComponent(sid)+'?include_items=false&include_usage=false', {method:'GET',headers,redirect:'error',signal:AbortSignal.timeout(5000)});
 if(response.status===404)return 'not_found';
 if(!response.ok)return null;
 const session=await response.json() as Record<string,unknown>;
 const labels=session.labels as Record<string,unknown> | undefined;
 if(session.id!==sid || session.agent_id!==providerAgent || (typeof host==='string' && session.host_id!==host) || labels?.['paperclip.company_id']!==run.companyId || labels?.['paperclip.agent_id']!==run.agentId || labels?.['paperclip.issue_key']!==`${run.companyId}:${run.agentId}:issue:${run.contextSnapshot?.issueId}`)return null;
 return session.runner_online===false ? 'runner_offline' : null;
}
