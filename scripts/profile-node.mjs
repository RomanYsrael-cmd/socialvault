import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { Reader, ZipReader, configure } from '@zip.js/zip.js';
configure({ useWebWorkers: false });
class LocalReader extends Reader {
  constructor(filename) { super(); this.fd=fs.openSync(filename,'r'); this.size=fs.statSync(filename).size; }
  async readUint8Array(offset,length) { const buffer=new Uint8Array(length); fs.readSync(this.fd,buffer,0,length,offset); return buffer; }
  close() { fs.closeSync(this.fd); }
}
const built=await build({stdin:{contents:"export {parseFacebookHtmlEntry} from './src/archive/adapters/facebook-html-adapter'; export {importMeter} from './src/archive/import-metrics';",resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'node'});
const {parseFacebookHtmlEntry,importMeter}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const files=fs.readdirSync(process.env.SOCIALVAULT_ARCHIVE,{recursive:true}).filter(p=>/\.zip$/i.test(p)).map(p=>path.join(process.env.SOCIALVAULT_ARCHIVE,p)).sort((a,b)=>fs.statSync(a).size-fs.statSync(b).size);
const candidate=p=>/profile_information|profile_v2|personal_information|(?:^|\/)posts\/|your_posts|(?:^|\/)messages\/|connections\/|comment|reaction|likes_and_reactions|\/album|albums|your_photos|your_videos/i.test(p);
for(let index=0;index<files.length;index++){
  if(process.argv[2]!=='metadata'&&index!==34) continue;
  const input=new LocalReader(files[index]),zip=new ZipReader(input);const start=performance.now();const entries=await zip.getEntries();const directoryMs=performance.now()-start;
  const html=entries.filter(e=>!e.directory&&/\.html?$/i.test(e.filename)&&candidate(e.filename)&&e.uncompressedSize<=512*1024*1024);
  console.log(JSON.stringify({event:'metadata',part:index+1,size:input.size,entries:entries.length,html:entries.filter(e=>/\.html?$/i.test(e.filename)).length,candidates:html.length,htmlBytes:html.reduce((n,e)=>n+e.uncompressedSize,0),compressedHtmlBytes:html.reduce((n,e)=>n+e.compressedSize,0),directoryMs}));
  if(process.argv[2]!=='metadata'){
    const counts={};const slowest=[];let finished=0;const parseStart=performance.now();
    for(const entry of html){const t=performance.now();let count=0;await parseFacebookHtmlEntry(entry,entry.filename,{onBatch:batch=>{for(const[k,v]of Object.entries(batch))if(Array.isArray(v)){counts[k]=(counts[k]??0)+v.length;count+=v.length;}}});slowest.push({file:++finished,bytes:entry.uncompressedSize,records:count,ms:performance.now()-t});slowest.sort((a,b)=>b.ms-a.ms);slowest.length=Math.min(slowest.length,10);if(finished%100===0)console.log(JSON.stringify({event:'progress',files:finished,ms:performance.now()-parseStart}));}
    console.log(JSON.stringify({event:'node-complete',part:index+1,ms:performance.now()-parseStart,counts,metrics:importMeter.snapshot(),slowest,rss:process.memoryUsage().rss}));
  }await zip.close();input.close();
}
