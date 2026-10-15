// Real packed module + SDK. Only the explicit private config mode "live" permits network/inference.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {WebSocket,WebSocketServer} from 'ws';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager} from '@earendil-works/pi-coding-agent';
process.umask(0o077);
const cfg=JSON.parse(await readFile(process.argv[2],'utf8'));
assert.ok(['fixture','live'].includes(cfg.mode));
const live=cfg.mode==='live';
if(live)assert.equal(cfg.confirmLive,true);
const {registerGithubResearch}=await import(pathToFileURL(cfg.module).href);
await mkdir(cfg.output,{recursive:true,mode:0o700});
const agent=cfg.output+'/agent';await mkdir(agent,{mode:0o700});
const nativeFetch=globalThis.fetch,NativeSocket=globalThis.WebSocket;
let server,wss,frames=0,wireGithub=0,activeHttp=0,connections=0,closed=0,fixtureFailure;
const events=[];let session,report;
const controller=new AbortController(),deadlineAt=Date.now()+110000;
const record=(kind,value)=>events.push({at:new Date().toISOString(),kind,...value});
if(!live){
 const token='fixture.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'fixture'}})).toString('base64url')+'.fixture';
 await writeFile(agent+'/auth.json',JSON.stringify({'openai-codex':{type:'oauth',access:token,refresh:'fixture',expires:Date.now()+3600000}}));
 const body='setting: example\npassword: fake-sensitive\n';
 const blob=createHash('sha1').update(`blob ${Buffer.byteLength(body)}\0`).update(body).digest('hex');
 globalThis.fetch=async(url,options)=>{
  assert.equal(new URL(url).origin,'https://api.github.com');assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
  wireGithub++;const endpoint=new URL(url).pathname.replace('/repos/fixture/research/','');
  const value=endpoint==='git/commits/'+'a'.repeat(40)?{sha:'a'.repeat(40),tree:{sha:'b'.repeat(40)},parents:[]}:
   endpoint==='git/trees/'+'b'.repeat(40)?{sha:'b'.repeat(40),truncated:false,tree:[{path:'README.md',type:'blob',mode:'100644',sha:blob,size:Buffer.byteLength(body)}]}:
   endpoint==='git/blobs/'+blob?{sha:blob,encoding:'base64',size:Buffer.byteLength(body),content:Buffer.from(body).toString('base64')}:null;
  assert.ok(value,endpoint);return new Response(JSON.stringify(value));
 };
 server=createServer();wss=new WebSocketServer({server});
 wss.on('connection',socket=>{
  connections++;socket.on('close',()=>closed++);
  const close=socket.close.bind(socket);
  if(cfg.scenario==='delayed-close')socket.close=(...a)=>setTimeout(()=>close(...a),1500);
  socket.on('message',data=>{try{
   const request=JSON.parse(data);frames++;assert.equal(request.model,'gpt-6-luna');assert.equal(request.service_tier,'default');assert.equal(request.reasoning.effort,'high');assert.equal(request.previous_response_id,undefined);
   if(cfg.scenario==='cancel'){setTimeout(()=>controller.abort(),10);return;}
   if(cfg.scenario==='provider-error'){socket.send(JSON.stringify({type:'error',error:{code:'websocket_connection_limit_reached',message:'synthetic'}}));return;}
   const action=frames===1?{operation:'file',repository:'fixture/research',path:'README.md'}:null;
   const id='item_'+frames,text='Observed setting: example. Configuration only; runtime behavior is unverified.';
   if(cfg.scenario==='redacted'&&frames>1)assert.ok(!data.toString().includes('fake-sensitive'));
   const item=action?{type:'function_call',id,call_id:id,name:'github_research_read',arguments:JSON.stringify(action)}:{type:'message',id,role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
   const emitted=[{type:'response.created',response:{id:'response_'+frames,status:'in_progress'}},{type:'response.output_item.added',output_index:0,item:action?{...item,arguments:''}:{...item,content:[]}}];
   if(action)emitted.push({type:'response.function_call_arguments.delta',item_id:id,output_index:0,delta:item.arguments},{type:'response.function_call_arguments.done',item_id:id,output_index:0,arguments:item.arguments});
   else emitted.push({type:'response.content_part.added',item_id:id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},{type:'response.output_text.delta',item_id:id,output_index:0,content_index:0,delta:text});
   emitted.push({type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'response_'+frames,status:'completed',model:'gpt-6-luna',service_tier:'default',output:[item],...(cfg.scenario==='missing-usage'?{}:{usage:{input_tokens:20,output_tokens:10,total_tokens:30,input_tokens_details:{cached_tokens:0}}})}});
   for(const e of emitted)socket.send(JSON.stringify(e));
  }catch(e){fixtureFailure=e;socket.terminate();}});
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 globalThis.WebSocket=class extends WebSocket {constructor(url,options){assert.equal(String(url),'wss://chatgpt.com/backend-api/codex/responses');super(`ws://127.0.0.1:${server.address().port}/codex/responses`,options);}};
}
const token=live?execFileSync('gh',['auth','token','--hostname','github.com'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim():'fixture-token';
const provider={api:'openai-completions',apiKey:'fixture',baseUrl:'http://127.0.0.1:1',models:[{id:'host',name:'Scripted host',reasoning:false,input:['text'],contextWindow:128000,maxTokens:16000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],streamSimple(model,context){
 const finished=context.messages.some(m=>m.role==='toolResult');
 const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:finished?'stop':'toolUse',content:finished?[{type:'text',text:'Research handoff received.'}]:[{type:'toolCall',id:'research',name:'github_research_run',arguments:{task:cfg.task}}],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
 const stream=createAssistantMessageEventStream();stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});stream.end();return stream;
}};
const settings=()=>SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false},cacheWarming:'off'});
const loader=new DefaultResourceLoader({cwd:cfg.output,agentDir:agent,settingsManager:settings(),noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:[pi=>{
 registerGithubResearch(pi,{standardPilot:{artifactRoot:cfg.output+'/children',authPath:live?cfg.authPath:agent+'/auth.json'},getBinding:(ctx,id)=>({taskId:'package-smoke',sessionId:ctx.sessionManager.getSessionId(),threadKey:'no-delivery',reservationId:'package-'+id,deadlineAt,repositories:cfg.grants}),token:async()=>token,fetch:async(url,options)=>{
  if(live)wireGithub++;
  activeHttp++;record('github-request',{path:new URL(url).pathname});
  try{const response=await globalThis.fetch(url,options);record('github-response',{status:response.status});return response;}finally{activeHttp--;}
 }});
 pi.on('tool_call',event=>{if(event.toolName==='github_research_read'){
  assert.equal(event.parentToolCallId,'research');record('parent-hook',{id:event.toolCallId});
  if(cfg.scenario==='blocked')return {block:true,reason:'HOST_DENIED'};
 }});
 pi.on('tool_result',event=>{if(event.toolName==='github_research_read'&&cfg.scenario==='redacted')return {content:event.content.map(p=>p.type==='text'?{...p,text:p.text.replaceAll('fake-sensitive','[REDACTED]')}:p),details:undefined};});
}]});
try{
 await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
 const runtime=await ModelRuntime.create({authPath:agent+'/parent-auth.json',modelsPath:null});runtime.registerProvider('package-host',provider);
 ({session}=await createAgentSession({cwd:cfg.output,agentDir:agent,modelRuntime:runtime,model:runtime.getModel('package-host','host'),thinkingLevel:'off',tools:['github_research_run','github_research_read'],resourceLoader:loader,settingsManager:settings(),sessionManager:SessionManager.inMemory(cfg.output)}));
 const abort=()=>void session.abort();controller.signal.addEventListener('abort',abort,{once:true});
 try{await session.prompt('Run the approved bounded question once.');}finally{controller.signal.removeEventListener('abort',abort);}
 if(fixtureFailure)throw fixtureFailure;
 const outer=session.messages.find(m=>m.role==='toolResult'&&m.toolName==='github_research_run');
 report=outer?JSON.parse(outer.content[0].text):null;
 await writeFile(cfg.output+'/result.json',JSON.stringify({report,enclosingUsage:outer?.usage,wireGithub,activeHttp,connections,closed,frames,live,events},null,2),{mode:0o600});
}finally{
 session?.dispose();
 for(const socket of wss?.clients??[])socket.terminate();
 if(wss)await new Promise(r=>wss.close(r));if(server)await new Promise(r=>server.close(r));
 globalThis.WebSocket=NativeSocket;globalThis.fetch=nativeFetch;
}
console.log(JSON.stringify({status:report?.status,error:report?.error,wireGithub,activeHttp,frames,cost:report?.usage?.cost?.total,cleanup:report?.research?.cleanupComplete}));
