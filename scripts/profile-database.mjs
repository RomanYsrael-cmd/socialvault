import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const baseURL = process.env.SOCIALVAULT_BASE_URL ?? 'http://127.0.0.1:4173';
const quiet = process.argv.includes('--quiet');
const positional = process.argv.slice(2).filter(value => !value.startsWith('--'));
for(const backend of (positional[0]??'memory,opfs').split(',')){
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'socialvault-benchmark-'));
const context=await chromium.launchPersistentContext(directory),page=await context.newPage();await page.goto(baseURL);
await page.exposeFunction('report',sample=>console.log(JSON.stringify(sample)));
await page.evaluate(async({backend,cache,total,target,quiet})=>{
  const worker=new Worker(`/src/database/database.worker.ts?benchmark=${backend}&cache=${cache}`,{type:'module'});let id=0,metrics;const pending=new Map();
  worker.onmessage=event=>{if(event.data.type==='pipeline-metrics'){metrics=event.data.metrics;return;}const promise=pending.get(event.data.id);if(promise){pending.delete(event.data.id);event.data.ok?promise.resolve(event.data.data):promise.reject(new Error(event.data.error));}};
  const call=request=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});worker.postMessage({...request,id:key});});
  const storage=await call({type:'init'});await window.report({event:'backend',backend,storage,cache,target});
  const part={id:'benchmark-part',archiveId:'benchmark-set',partIndex:0,filename:'synthetic.zip',fileSize:1,entryCount:1,manifestFingerprint:'benchmark',connected:true,status:'ready'};
  const empty=()=>({people:[],profileFacts:[],posts:[],comments:[],reactions:[],connections:[],albums:[],conversations:[],messages:[],media:[],warnings:[]});
  const state=await call({type:'begin-import',data:{...empty(),archiveParts:[part]}}),sessionId=state.session.id;
  let committed=0;const start=performance.now();let peak=0,sum=0,batches=0;
  while(committed<total){const batch=empty();batch.conversations=[{id:'thread',participantIds:['sender'],participantNames:['Synthetic Sender'],source:{platform:'facebook',path:'messages/inbox/synthetic/message_1.html'}}];batch.people=[{id:'sender',displayName:'Synthetic Sender',sourcePaths:['messages/inbox/synthetic/message_1.html']}];
    for(let i=0;i<Math.min(target,total-committed);i++)batch.messages.push({id:`message:${(Math.imul(committed+i,2654435761)>>>0).toString(16).padStart(8,'0')}`,conversationId:'thread',senderId:'sender',senderName:'Synthetic Sender',text:'Synthetic text for local throughput validation. '.repeat(3),sentAt:new Date(1600000000000+(committed+i)*1000).toISOString(),source:{platform:'facebook',path:'messages/inbox/synthetic/message_1.html',index:committed+i}});
    const t=performance.now();await call({type:'import-batch',data:batch,part,sessionId});const latency=performance.now()-t;sum+=latency;peak=Math.max(peak,latency);batches++;committed+=batch.messages.length;
    if(!quiet && (committed%10000===0||committed===total))await window.report({event:'database',backend,cache,rows:committed,ms:performance.now()-start,avgMs:sum/batches,maxMs:peak,commit:metrics?.stages.commit,base:metrics?.stages['base-write']});
  }await window.report({event:'database-complete',backend,cache,rows:committed,ms:performance.now()-start,storage:await call({type:'storage-status'}),commit:metrics?.stages.commit,base:metrics?.stages['base-write']});worker.terminate();
},{backend,cache:Number(positional[1]??2048),total:Number(positional[2]??10000),target:Number(positional[3]??5000),quiet});
await context.close();
if(path.resolve(directory).startsWith(path.join(os.tmpdir(),'socialvault-benchmark-'))) {
  try { fs.rmSync(directory,{recursive:true,force:true,maxRetries:8,retryDelay:250}); } catch { /* browser cleanup can lag on Windows; the profile is outside the repository */ }
}
}
