/**
 * @fileoverview Public API for the Serato Remote OSC-over-TCP client.
 *
 * See ../docs/protocol.md for protocol details and ../docs/open-questions.md
 * for behaviors still pending live-session confirmation.
 */

export { SeratoRemoteClient } from './client.js';
export {
  RemoteServer,
  RemoteSession,
  type RemoteServerEvents,
  type RemoteServerOptions,
  type RemoteSessionEvents,
  type RemoteSessionOptions,
  type RemoteSessionPeer,
} from './server.js';
export {
  publishSeratoRemote,
  buildInstanceName,
  SERATO_REMOTE_SERVICE_TYPE,
  type MdnsPublication,
  type MdnsPublishOptions,
} from './mdns.js';
export {
  encodeOsc,
  decodeOsc,
  osc,
  arg,
  type OscArg,
  type OscMessage,
} from './osc.js';
export { frameOsc, FrameReader } from './framing.js';
export {
  NUM_REMOTE_DECKS,
  DEFAULT_SUBSCRIPTION_TOPICS,
  type SeratoRemoteOptions,
  type SeratoRemoteEvents,
  type SeratoRemoteEmitter,
  type SeratoRemoteTrack,
  type SeratoRemotePlayhead,
  type SeratoRemoteLoopState,
  type SeratoRemoteMixerState,
  type SeratoRemoteDeckChangePayload,
  type SeratoRemotePlayheadPayload,
  type SeratoRemoteLoopPayload,
  type SeratoRemoteMixerPayload,
  type SeratoRemoteReadyInfo,
  type SeratoRemotePeerInfo,
} from './types.js';
