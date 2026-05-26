import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { resolve } from 'node:path';

let stream: WriteStream | null = null;
function out(): WriteStream {
  if (!stream) {
    mkdirSync(resolve('data'), { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    stream = createWriteStream(resolve('data', `live-events-${date}.jsonl`), { flags: 'a' });
  }
  return stream;
}
export function logEvent(ev: Record<string, unknown>): void {
  out().write(JSON.stringify({ ts: Date.now(), ...ev }) + '\n');
}
export async function closeLog(): Promise<void> {
  await new Promise<void>((r) => (stream ? stream.end(() => r()) : r()));
}
