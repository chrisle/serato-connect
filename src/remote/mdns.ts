/**
 * @fileoverview Bonjour publisher for the `_SeratoIOSRemote._tcp` service.
 *
 * Serato DJ Pro browses for this service and connects to whatever is
 * advertising it. We publish a bare advert (empty TXT) and let Serato drive
 * the TCP handshake on top.
 *
 * Uses bonjour-service to avoid pulling in native dependencies.
 */

import { hostname } from 'node:os';
import type { Logger } from '../types/logger.js';
import { noopLogger } from '../types/logger.js';

/**
 * Service-type fragment of the Bonjour record. Combined by bonjour-service
 * into the full `_SeratoIOSRemote._tcp.local.` address.
 */
export const SERATO_REMOTE_SERVICE_TYPE = 'SeratoIOSRemote';

export interface MdnsPublishOptions {
  /** Display name (without hostname suffix) — e.g. "serato-connect". */
  peerName: string;
  /** Port the OSC TCP server is listening on. */
  port: number;
  /** Optional injected hostname (mostly for tests). */
  host?: string;
  /** Logger instance. */
  logger?: Logger;
}

export interface MdnsPublication {
  /** Full Bonjour instance name as published (e.g. "MyApp @ studio.local"). */
  instanceName: string;
  /** Port being advertised. */
  port: number;
  /** Tear down the advert and the underlying mDNS responder. */
  stop(): Promise<void>;
}

/**
 * Build the canonical instance name used by Serato Remote: `<peerName> @ <hostname>`
 * with the literal `@` separator and surrounding spaces. Passing a
 * `.local`-suffixed hostname is fine — bonjour-service won't double-suffix.
 */
export function buildInstanceName(peerName: string, host: string = hostname()): string {
  return `${peerName} @ ${host}`;
}

/**
 * Publish the Bonjour service. Returns a handle whose `stop()` tears down
 * both the advert and the responder. Designed to be lightweight enough that
 * a caller can publish, run a session, and then tear down without leaking
 * sockets.
 */
export async function publishSeratoRemote(
  options: MdnsPublishOptions
): Promise<MdnsPublication> {
  const logger = options.logger ?? noopLogger;
  const instanceName = buildInstanceName(options.peerName, options.host);

  // Lazy-load bonjour-service so the rest of the package doesn't pull it in
  // when the consumer only uses the file-based readers.
  const mod = await import('bonjour-service');
  const Bonjour = (mod as unknown as { Bonjour: new () => BonjourLike }).Bonjour
    ?? (mod as unknown as { default: new () => BonjourLike }).default;

  if (typeof Bonjour !== 'function') {
    throw new Error('bonjour-service is not installed; install it to use the Serato Remote protocol');
  }

  const bonjour = new Bonjour();
  const service: BonjourServiceLike = bonjour.publish({
    name: instanceName,
    type: SERATO_REMOTE_SERVICE_TYPE,
    protocol: 'tcp',
    port: options.port,
    // Empty TXT record — Serato accepts a bare advert.
    txt: {},
  });

  logger.info('mdns: publishing %s on port %d', instanceName, options.port);

  return {
    instanceName,
    port: options.port,
    stop: () =>
      new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          try {
            bonjour.destroy();
          } catch (err) {
            logger.warn('mdns: error destroying responder', err);
          }
          resolve();
        };
        try {
          service.stop(finish);
          // Bail out if stop() never fires the callback (some bonjour
          // implementations don't on certain platforms).
          setTimeout(finish, 1000).unref?.();
        } catch (err) {
          logger.warn('mdns: error stopping advert', err);
          finish();
        }
      }),
  };
}

interface BonjourServiceLike {
  stop(cb: () => void): void;
}

interface BonjourLike {
  publish(opts: {
    name: string;
    type: string;
    protocol: 'tcp' | 'udp';
    port: number;
    txt?: Record<string, string>;
  }): BonjourServiceLike;
  destroy(): void;
}
