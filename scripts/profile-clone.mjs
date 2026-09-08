// Local-only structured-clone probe. Measures a synthetic worker round trip;
// no archive data or network resources are involved.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const baseURL = process.env.SOCIALVAULT_BASE_URL ?? 'http://127.0.0.1:4173';
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'socialvault-clone-profile-'));
const context = await chromium.launchPersistentContext(profileDir, {
  executablePath: process.env.SOCIALVAULT_BROWSER || undefined,
});
const page = await context.newPage();
await page.goto(baseURL);

const results = await page.evaluate(async () => {
  const workerSource = `self.onmessage = (event) => {
    const payload = event.data;
    self.postMessage({ rows: payload.rows.length, payloadBytes: payload.payloadBytes });
  };`;
  const objectUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
  const worker = new Worker(objectUrl);
  const targetMiB = [1, 2, 4, 8];
  const rowCounts = [250, 500, 1000, 2500, 5000];

  const roundTrip = (payload) => new Promise((resolve, reject) => {
    const started = performance.now();
    const onMessage = (event) => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      resolve({ ...event.data, ms: performance.now() - started });
    };
    const onError = (event) => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      reject(event.error || new Error('worker clone probe failed'));
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    // Deliberately omit a transfer list: this is the structured-clone path used
    // by the import/database workers.
    worker.postMessage(payload);
  });

  const output = [];
  for (const mib of targetMiB) {
    for (const rows of rowCounts) {
      const targetBytes = mib * 1024 * 1024;
      const textLength = Math.max(32, Math.floor(targetBytes / rows) - 48);
      const records = Array.from({ length: rows }, (_, index) => ({
        id: `synthetic-${index}`,
        text: 'x'.repeat(textLength),
      }));
      const payload = { rows: records, payloadBytes: new Blob([JSON.stringify(records)]).size };
      // Warm the worker once so the first row is not dominated by startup.
      await roundTrip({ rows: [{ id: 'warmup', text: 'x' }], payloadBytes: 32 });
      const samples = [];
      for (let sample = 0; sample < 3; sample += 1) {
        samples.push((await roundTrip(payload)).ms);
      }
      output.push({
        targetMiB: mib,
        rows,
        payloadBytes: payload.payloadBytes,
        payloadMiB: payload.payloadBytes / (1024 * 1024),
        samplesMs: samples,
        avgMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
        maxMs: Math.max(...samples),
      });
    }
  }
  worker.terminate();
  URL.revokeObjectURL(objectUrl);
  return output;
});

for (const result of results) console.log(JSON.stringify({ event: 'clone', ...result }));
await context.close();
try {
  fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
} catch {
  // Browser cleanup can lag on Windows; this profile is outside the repository.
}
