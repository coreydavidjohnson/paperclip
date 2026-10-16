import {describe,it,expect} from 'vitest';
import {probeOmnigentAdmission} from './omnigent-admission-probe.js';
import type {heartbeatRuns} from '@paperclipai/db';
const receipt={version:1,runId:'run',companyId:'co',agentId:'agent',omnigentSessionId:'session',state:'accepted'};
const run={id:'run',companyId:'co',agentId:'agent',contextSnapshot:{issueId:'issue'},resultJson:{omnigentDispatchReceipt:receipt}} as unknown as typeof heartbeatRuns.$inferSelect;
const config={baseUrl:'http://provider',agentId:'provider-agent',hostId:'host',headers:{Authorization:'Bearer synthetic-test-only'}};
const session={id:'session',agent_id:'provider-agent',host_id:'host',runner_online:false,labels:{'paperclip.company_id':'co','paperclip.agent_id':'agent','paperclip.issue_key':'co:agent:issue:issue'}};
describe('read-only negative admission evidence',()=>{
 it('accepts exact session 404 without provider mutations',async()=>{
  const request=async(url:unknown,init?:RequestInit)=>{
   expect(String(url)).toBe('http://provider/v1/sessions/session?include_items=false&include_usage=false');
   expect(init?.method).toBe('GET');expect(init?.body).toBeUndefined();expect(init?.redirect).toBe('error');
   expect(new Headers(init?.headers).get('X-Databricks-Omnigent-Slice-Key')).toBe('host');
   return new Response('',{status:404});
  };
  expect(await probeOmnigentAdmission(run,config,request as typeof fetch)).toBe('not_found');
 });
 it('accepts only bound runner offline, not idle or no runner field',async()=>{
  for(const runner of [false,true,undefined]){
   expect(await probeOmnigentAdmission(run,config,async()=>Response.json({...session,runner_online:runner}))).toBe(runner===false?'runner_offline':null);
  }
 });
 it.each([401,403,429,500,503])('does not turn HTTP %s into missing evidence',async status=>{
  expect(await probeOmnigentAdmission(run,config,async()=>new Response('',{status}))).toBeNull();
 });
 it.each(['id','agent_id','host_id','labels'])('rejects changed %s',async field=>{
  expect(await probeOmnigentAdmission(run,config,async()=>Response.json({...session,[field]:field==='labels'?{}:'foreign'}))).toBeNull();
 });
 it('does not query an invalid receipt',async()=>{
  expect(await probeOmnigentAdmission({...run,resultJson:{omnigentDispatchReceipt:{...receipt,runId:'foreign'}}},config,async()=>{throw Error('must not query')})).toBeNull();
 });
});
