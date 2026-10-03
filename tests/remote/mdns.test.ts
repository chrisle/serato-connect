import { describe, expect, it, vi } from 'vitest';
import { publishSeratoRemote } from '../../src/remote/mdns.js';

const state = vi.hoisted(() => ({
  errorCallback: null as ((error: Error) => void) | null,
}));

vi.mock('bonjour-service', () => ({
  Bonjour: class {
    publish() {
      return { stop: (callback: () => void) => callback() };
    }

    constructor(_options: unknown, errorCallback: (error: Error) => void) {
      state.errorCallback = errorCallback;
    }

    destroy() {}
  },
}));

describe('publishSeratoRemote', () => {
  it('logs mDNS socket errors instead of allowing them to be thrown uncaught', async () => {
    const warnings: unknown[][] = [];
    const logger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: (...args: unknown[]) => warnings.push(args),
      error: vi.fn(),
    };

    await publishSeratoRemote({ peerName: 'test', port: 51337, logger });
    const error = new Error('send EADDRNOTAVAIL');

    expect(() => state.errorCallback?.(error)).not.toThrow();
    expect(warnings).toEqual([['mdns: responder error', error]]);
  });
});
