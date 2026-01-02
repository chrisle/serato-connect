export { SeratoConnect, getDefaultSeratoPath, detectSeratoInstallation } from './seratoConnect';
export type {
  SeratoConnectOptions,
  SeratoConnectEvents,
  SeratoHistorySong,
  SeratoSession,
  SeratoReadyInfo,
  SeratoTrackPayload,
  SeratoHistoryPayload,
  SeratoSessionPayload,
} from './types';
export {
  getSeratoHistory,
  getSessions,
  getSessionSongs,
  getLatestSessionPath,
  CHUNK_TAGS,
} from './historyParser';
