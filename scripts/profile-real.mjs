// Local-only validation. Pass the source directory through SOCIALVAULT_ARCHIVE.
// Output contains counts/timings only; no archive filenames or record values.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from '@playwright/test';
const files = fs.readdirSync(process.env.SOCIALVAULT_ARCHIVE, { recursive: true }).filter(p => /\.zip$/i.test(p)).map(p => path.join(process.env.SOCIALVAULT_ARCHIVE, p)).sort((a,b) => fs.statSync(a).size-fs.statSync(b).size);
const mode = process.argv[2] ?? 'heavy';
const baseURL = process.env.SOCIALVAULT_BASE_URL ?? 'http://127.0.0.1:4173';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'socialvault-real-profile-'));
const context = await chromium.launchPersistentContext(directory, { executablePath: process.env.SOCIALVAULT_BROWSER || undefined });
const browser = context.browser();
const page = await context.newPage();
let errors = 0; page.on('pageerror', () => errors++);
page.on('console', msg => { if (msg.type() === 'error') errors++; });
await page.goto(baseURL);
const selected = mode === 'full' ? files : mode === '5' || mode === '10' ? [files[34], ...files.filter((_,i)=>i!==34).slice(0,Number(mode)-1)] : [files[34]];
await page.locator('input[type=file]').first().setInputFiles(selected);
await page.getByRole('button', { name: /Inspect archive/i }).click();
await page.waitForURL('**/archive', {timeout: 300000});
console.log(JSON.stringify({event:'inspected', parts:selected.length, bytes:selected.reduce((n,p)=>n+fs.statSync(p).size,0)}));
await page.getByRole('button', {name:/Start local import/i}).click();
const started = Date.now();
while (true) {
  await new Promise(resolve=>setTimeout(resolve,10000));
  const sample = await page.evaluate(async () => {
    const {liveImportMetrics} = await import('/src/archive/import-metrics.ts');
    return { metrics: structuredClone(liveImportMetrics), heap: performance.memory?.usedJSHeapSize, dom: document.querySelectorAll('*').length };
  });
  const dbStages = sample.metrics.database?.stages ?? {};
  console.log(JSON.stringify({event:'sample', elapsed:Date.now()-started, heap:sample.heap,dom:sample.dom,parser:sample.metrics.parser?.stages,dbStage:sample.metrics.database?.stage,db:dbStages['base-write'],search:dbStages['search-documents'],fts:dbStages['fts-indexing'],activity:dbStages['activity-derivation'],browsing:dbStages['browsing-indexes'],commit:dbStages.commit,errors}));
  if (await page.getByRole('button',{name:'Imported',exact:true}).count()) {
    const result=await page.evaluate(async()=> {const {database}=await import('/src/database/client.ts');const stats=await database.stats();return {storage:await database.storageStatus(),counts:Object.fromEntries(Object.entries(stats).filter(([k,v])=>typeof v==='number')),diagnostics:await database.diagnostics()};});
    console.log(JSON.stringify({event:'complete',elapsed:Date.now()-started,...result,errors})); break;
  }
  // Stop only a failed/interrupted workflow, not a time-based healthy import.
  if(await page.getByText('Import paused. Reconnect the remaining ZIP parts to continue.',{exact:true}).count()) {console.log(JSON.stringify({event:'interrupted',elapsed:Date.now()-started}));break;}
}
await context.close();
if(path.resolve(directory).startsWith(path.join(os.tmpdir(),'socialvault-real-profile-'))) {
  try { fs.rmSync(directory,{recursive:true,force:true,maxRetries:8,retryDelay:250}); } catch { /* browser cleanup can lag on Windows; the profile is outside the repository */ }
}
