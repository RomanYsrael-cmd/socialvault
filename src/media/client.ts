type Request = { id: number; file: File; path: string; mimeType?: string; archivePartId?: string };
type Response = { id: number; ok: true; blob: Blob } | { id: number; ok: false; error: string };
let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, { resolve: (blob: Blob) => void; reject: (error: Error) => void }>();
function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('../workers/media.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<Response>) => { const task = pending.get(event.data.id); if (!task) return; pending.delete(event.data.id); event.data.ok ? task.resolve(event.data.blob) : task.reject(new Error(event.data.error)); };
    worker.onerror = () => { for (const task of pending.values()) task.reject(new Error('Media worker stopped.')); pending.clear(); worker?.terminate(); worker = undefined; };
  }
  return worker;
}
export const mediaClient = { extract(file: File, path: string, mimeType?: string, archivePartId?: string) { const id = ++sequence; return new Promise<Blob>((resolve, reject) => { pending.set(id, { resolve, reject }); getWorker().postMessage({ id, file, path, mimeType, archivePartId } satisfies Request); }); } };
