// Public surface of the platform-independent sync engine (SPEC.md §4). It
// must never import `obsidian` or src/obsidian (lint-enforced).
export { SyncEngine, type PullSummary, type PushSummary, type RejectedOperation, type SyncEngineOptions } from "./engine/engine";
export { deferMerge, threeWayMerge, type MergeHook, type MergeOutcome, type MergeRequest } from "./engine/merge";
export { classifyByExtension, classifyByExtensions, defaultTextExtensions, RemoteContentError, type PullApi } from "./engine/remote";
export { sha256Hex } from "./hash";
export type {
  ConflictReason,
  ConflictRecord,
  DeferReason,
  DeferredRevision,
  DocumentKindName,
  DocumentState,
  Journal,
  PendingOperation,
  RemoteRevision,
} from "./journal/journal";
export { InMemoryJournal } from "./journal/memory";
export { conflictCopyPath } from "./merge/conflict-name";
export { mergeText } from "./merge/text-merge";
export { pathKey } from "./pathkey/pathkey";
export {
  defaultScope,
  discoverOidc,
  IdentityProviderError,
  jwtExpiry,
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
export { isVaultRelativePath } from "./vaultpath/vaultpath";
