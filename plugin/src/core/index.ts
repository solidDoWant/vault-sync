// Public surface of the platform-independent sync engine (SPEC.md §4). It
// must never import `obsidian` or src/obsidian (lint-enforced).
export { SyncEngine, type PullSummary, type PushSummary, type RejectedOperation, type SyncEngineOptions } from "./engine/engine";
export { deferMerge, type MergeHook, type MergeOutcome, type MergeRequest } from "./engine/merge";
export { classifyByExtension, RemoteContentError, type PullApi } from "./engine/remote";
export { sha256Hex } from "./hash";
export type {
  DeferReason,
  DeferredRevision,
  DocumentKindName,
  DocumentState,
  Journal,
  PendingOperation,
  RemoteRevision,
} from "./journal/journal";
export { InMemoryJournal } from "./journal/memory";
export { pathKey } from "./pathkey/pathkey";
export {
  createHttpTransport,
  createProtocolClient,
  withBearerToken,
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
