// Public surface of the platform-independent sync engine (SPEC.md §4). It
// must never import `obsidian` or src/obsidian (lint-enforced).
export { DivergedError, SyncEngine, type RefusedName, type SyncApi, type SyncEngineOptions, type SyncProblems, type SyncStatus, type TooLargeFile } from "./sync/engine";
export { commitRestore, documentHistory, readRevision, RestoreError, type HistoryEntry, type HistoryPage, type RestoreFailure } from "./sync/history";
export { IndexedDbSyncJournal } from "./sync/indexeddb";
export { MemorySyncJournal, type ConflictEntry, type Cursor, type DocEntry, type JournalChange, type JournalState, type PendingOp, type SkippedEntry, type SkipReason, type SyncJournal, type SyncKind } from "./sync/journal";
export { RemoteContentError, type DocumentKindName, type PullApi, type RemoteRevision } from "./sync/remote";
export { sha256Hex } from "./hash";
export { mergeText } from "./merge/text-merge";
export { pathKey } from "./pathkey/pathkey";
export {
  defaultScope,
  discoverOidc,
  IdentityProviderError,
  jwtExpiry,
  jwtSubject,
  OAuthError,
  oidcRefresher,
  pollDeviceAuthorization,
  refreshAccessToken,
  requireSecureUrl,
  signInWithDeviceFlow,
  SignInRequiredError,
  startDeviceAuthorization,
  type DeviceAuthorization,
  type DeviceSignInOptions,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  type OidcClientConfig,
  type OidcEndpoints,
  type PollOptions,
  type TokenSet,
} from "./auth/oidc";
export { TokenManager, type AuthState, type TokenManagerOptions } from "./auth/tokens";
export {
  createHttpTransport,
  createProtocolClient,
  withAuthentication,
  withBearerToken,
  type Authenticator,
  type ProtocolClient,
  type ProtocolClientOptions,
  type TokenSource,
} from "./protocol/client";
export {
  bearerSubprotocolPrefix,
  RealtimeClient,
  realtimeSubprotocol,
  realtimeUrl,
  reconnectDelay,
  type RealtimeBackoff,
  type RealtimeClientOptions,
  type RealtimeConnector,
  type RealtimeSocket,
  type RealtimeSocketHandlers,
  type RealtimeTimers,
} from "./realtime/client";
export { InMemoryRealtimeConnection, InMemoryRealtimeServer, type InMemoryRealtimeOptions } from "./realtime/memory";
export { isProtocolCompatible, PROTOCOL_VERSION } from "./version";
export {
  isVaultError,
  VaultError,
  type FileStat,
  type VaultAdapter,
  type VaultErrorCode,
  type VaultEvent,
  type VaultListener,
} from "./vault/adapter";
export {
  ConformanceFailure,
  runConformanceCase,
  vaultAdapterConformance,
  type ConformanceCase,
  type ConformanceOptions,
  type VaultAdapterFactory,
  type VaultAdapterHarness,
} from "./vault/conformance";
export { InMemoryVault, type InMemoryVaultOptions } from "./vault/memory";
export { uuidv7 } from "./uuid";
export { posixPathRules, unmaterializableReason, type PathPlatform, type PathRules, type UnmaterializableCause, type UnmaterializableReason } from "./vaultpath/platform";
export { isVaultRelativePath } from "./vaultpath/vaultpath";
