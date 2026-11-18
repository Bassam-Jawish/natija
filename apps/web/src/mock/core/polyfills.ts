/**
 * Browser stand-ins the shared packages expect: @natija/protocols frames analyzer messages with
 * Node's Buffer, and its link simulation lets each side settle with setImmediate. Imported first
 * by the mock entry, before any module that uses them.
 */
import { Buffer } from 'buffer';

const g = globalThis as unknown as { Buffer?: typeof Buffer };
g.Buffer ??= Buffer;

/** setImmediate on a MessageChannel (a macrotask, like Node's), or a 0 ms timeout where that is missing. */
const gi = globalThis as unknown as { setImmediate?: (fn: () => void) => void };
if (typeof gi.setImmediate !== 'function') {
  if (typeof MessageChannel === 'function') {
    const queue: Array<() => void> = [];
    const channel = new MessageChannel();
    channel.port1.onmessage = () => queue.shift()?.();
    gi.setImmediate = (fn) => {
      queue.push(fn);
      channel.port2.postMessage(null);
    };
  } else {
    gi.setImmediate = (fn) => void setTimeout(fn, 0);
  }
}
