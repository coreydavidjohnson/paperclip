// Exact HTTP contract used by real adapter; NOT OmniGenT/PER285 acceptance.
import express from "express";
const app=express(); app.use(express.json());
let session:any=null, items:any[]=[], messages=0, interrupts=0, approvals=0, token="", runId="";
const responseId=crypto.randomUUID(), turnId=crypto.randomUUID();
app.post('/v1/sessions',(req,res)=>{session={id:crypto.randomUUID(),agent_id:req.body.agent_id,labels:req.body.labels,status:'idle',runner_online:true,host_online:true};res.json(session);});
app.get('/v1/sessions',(_req,res)=>res.json({data:session?[session]:[],has_more:false}));
app.get('/v1/sessions/:sid',(_req,res)=>res.json(session));
app.patch('/v1/sessions/:sid',(req,res)=>{Object.assign(session,req.body);res.json(session);});
app.get('/v1/sessions/:sid/items',(req,res)=>{let data=items.slice();const after=String(req.query.after??'');if(after)data=data.slice(data.findIndex(x=>x.id===after)+1);if(req.query.order==='desc')data.reverse();res.json({data:data.slice(0,Number(req.query.limit??100)),has_more:false});});
app.get('/v1/sessions/:sid/stream',(_req,res)=>res.status(404).end());
app.post('/v1/sessions/:sid/events',(req,res)=>{
 if(req.body.type==='interrupt'){interrupts++;session.status='idle';session.active_response_id=null;return res.json({queued:true});}
 if(req.body.type==='approval'){approvals++;return res.json({queued:true});}
 if(req.body.type!=='message')return res.status(400).json({error:'unsupported fixture event'});
 messages++;const text=req.body.data.content[0].text;
 token=text.match(/PAPERCLIP_API_KEY=([^\s]+)/)?.[1]??'';
 runId=text.match(/Paperclip run ID: ([0-9a-f-]+)/)?.[1]??'';
 items.push({id:crypto.randomUUID(),type:'message',role:'user',content:[{type:'input_text',text}],response_id:responseId,turn_id:turnId});
 session.status='running';session.active_response_id=responseId;
 res.json({queued:true,pending_id:crypto.randomUUID()});
});
app.post('/reset',(_req,res)=>{session=null;items=[];messages=0;interrupts=0;approvals=0;token='';runId='';res.json({reset:true});});
app.post('/finish',(_req,res)=>{items.push({id:crypto.randomUUID(),type:'message',role:'assistant',phase:'final',status:'completed',response_id:responseId,turn_id:turnId,content:[{type:'output_text',text:'Original long turn completed once.'}]});session.status='idle';session.active_response_id=null;res.json({finished:true});});
app.get('/evidence',(_req,res)=>res.json({sessionId:session?.id,responseId,turnId,userItemId:items[0]?.id,messages,interrupts,approvals,runId,token}));
app.listen(6767,'0.0.0.0');
