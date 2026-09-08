import { describe, expect, it } from 'vitest';
import { ImportMeter, possibleStall } from './import-metrics';
import { batchRows, estimateValueBytes, splitBatch } from './batch-size';
import { emptyNormalizedData } from './adapters/facebook-parser';

describe('bounded acknowledged import measurements', () => {
  it('bounds rows and includes nested provenance in the payload estimate', () => {
    const input = emptyNormalizedData();
    input.completedSourcePaths = ['messages/inbox/synthetic/message_1.html'];
    input.messages = Array.from({ length: 12_001 }, (_, index) => ({ id: `message:${index}`, conversationId: 'conversation', text: '你好🌍'.repeat(index % 9 + 1), source: { platform: 'facebook', path: 'messages/inbox/synthetic/message_1.html', index } }));
    const chunks = [...splitBatch(input, 500, 128 * 1024)];
    expect(chunks.flatMap(chunk => chunk.messages)).toEqual(input.messages);
    expect(chunks.every(chunk => batchRows(chunk) <= 500)).toBe(true);
    expect(chunks.slice(0,-1).every(chunk => !chunk.completedSourcePaths)).toBe(true);
    expect(chunks.at(-1)?.completedSourcePaths).toEqual(input.completedSourcePaths);
    for (const chunk of chunks) expect(estimateValueBytes(chunk)).toBeGreaterThan(new TextEncoder().encode(JSON.stringify(chunk)).length);
  });
  it('never truncates a single oversized record and can checkpoint an empty source', () => {
    const input = emptyNormalizedData(); input.messages.push({ id: 'large', conversationId: 'thread', text: 'x'.repeat(10_000), source: { platform: 'facebook', path: 'message.html' } });
    expect([...splitBatch(input, 1, 1024)][0].messages[0].text).toHaveLength(10_000);
    const empty = emptyNormalizedData(); empty.completedSourcePaths = ['empty.html'];
    expect([...splitBatch(empty)]).toHaveLength(1);
  });
  it('keeps aggregate size constant and does not mistake database polling for progress', () => {
    const meter = new ImportMeter(); meter.updatedAt = 1;
    for (let i=0; i<10_000; i++) meter.add('sql:import_sessions', 2);
    expect(Object.keys(meter.stages)).toHaveLength(1);
    expect(possibleStall(meter.snapshot(), 60_002)).toBe(true);
    meter.add('base-write', 25, 500);
    expect(possibleStall(meter.snapshot())).toBe(false);
    expect(meter.stages['base-write'].maxMs).toBe(25);
  });
});
