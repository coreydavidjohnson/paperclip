import { describe, expect, it } from 'vitest';
import { probeNewestIssueSession } from './omnigent-issue-session.js';
const identity={companyId:'co',agentId:'agent',issueId:'issue'};
const config={baseUrl:'http://provider',agentId:'provider-agent',hostId:'host'};
const labels={'paperclip.company_id':'co','paperclip.agent_id':'agent','paperclip.issue_key':'co:agent:issue:issue'};
const old={id:'old',agent_id:'provider-agent',host_id:'host',labels,status:'idle',created_at:'2026-10-19T00:00:00Z'};
const current={...old,id:'new',created_at:'2026-10-20T00:00:00Z'};
function fake(sessions:unknown[],detail:Record<string,unknown>=current) {
 const calls:string[]=[];
 const request:typeof fetch=async(url,init)=>{
  expect(init?.method).toBe('GET');expect(init?.body).toBeUndefined();
  const path=new URL(String(url)).pathname;calls.push(path);
  return Response.json(path==='/v1/sessions' ? {data:sessions,has_more:false} : path.endsWith('/items') ? {data:[{id:'tail'}]} : detail);
 };
 return {request,calls};
}
describe('newest owned issue-label session evidence',()=>{
 it('ignores run-stored columns and finds newer labeled session',async()=>{
  const f=fake([current,old]);const result=await probeNewestIssueSession(identity,config,f.request);
  expect(result).toMatchObject({id:'new',idle:true});expect(f.calls).not.toContain('/v1/sessions/old');
 });
 it('does not retire newer busy Codex work despite quiet old runs',async()=>{
  const f=fake([current,old],{...current,status:'running'});
  expect(await probeNewestIssueSession(identity,config,f.request)).toMatchObject({id:'new',idle:false});
 });
 it.each(['active_response_id','pending_inputs','pending_elicitations'])('preserves %s',async key=>{
  const f=fake([current],{...current,[key]:key==='active_response_id'?'response':['pending']});
  expect(await probeNewestIssueSession(identity,config,f.request)).toMatchObject({idle:false});
 });
 it('does not lose older duplicate live work',async()=>{
  const f=fake([current,{...old,status:'running'}]);
  expect(await probeNewestIssueSession(identity,config,f.request)).toMatchObject({id:'new',idle:false});
 });
 it('fails closed on incomplete discovery instead of using stored session',async()=>{
  const request:typeof fetch=async()=>Response.json({data:[current],has_more:true});
  expect(await probeNewestIssueSession(identity,config,request)).toBeNull();
 });
 it.each(['labels','agent_id','host_id','id'])('rejects changed %s ownership on fresh metadata read',async key=>{
  const f=fake([current],{...current,[key]:key==='labels'?{}:'foreign'});
  expect(await probeNewestIssueSession(identity,config,f.request)).toBeNull();
 });
 it('selects newest by creation time, not unordered list position',async()=>{
  const f=fake([old,current]);expect(await probeNewestIssueSession(identity,config,f.request)).toMatchObject({id:'new'});
  expect(f.calls).toContain('/v1/sessions/new');
 });
 it('represents complete absence distinctly from a failed lookup',async()=>{
  const f=fake([]);expect(await probeNewestIssueSession(identity,config,f.request)).toMatchObject({absent:true,idle:true});
 });
});
