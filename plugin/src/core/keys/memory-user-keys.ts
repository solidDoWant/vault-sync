/**
 * An in-memory UserKeyService for tests, following the contract of
 * proto/vaultsync/v1/user_key.proto (and the Go server, #665) for one user:
 * create-only storage, release of the wrapped key only for the right
 * auth_key, re-wrapping on a passphrase change, and the failed-attempt limit with its retry time. Every request
 * is also recorded serialized, as it would cross the network.
 */
import { create, toBinary, type DescMessage } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { sha256 } from "@noble/hashes/sha2.js";
import { Code, ConnectError, createRouterTransport, type Transport } from "@connectrpc/connect";

import { ErrorDetailSchema, ErrorReason } from "../../gen/vaultsync/v1/errors_pb";
import { UserKeyService, type PassphraseParams } from "../../gen/vaultsync/v1/user_key_pb";

/** The server's limit: failed attempts per window. */
export const MAX_FAILED_ATTEMPTS = 10;
/** The server's window, from the first counted failure. */
export const ATTEMPT_WINDOW_MS = 60 * 60 * 1000;

interface StoredKey {
  publicKey: Uint8Array;
  wrappedPrivateKey: Uint8Array;
  params: PassphraseParams;
  authKeyHash: Uint8Array;
}

/** A request as sent: the procedure name and its serialized bytes. */
export interface RecordedRequest {
  procedure: string;
  bytes: Uint8Array;
}

export class MemoryUserKeyServer {
  /** The user's stored key, if any. */
  stored: StoredKey | undefined;
  /** Every request any client sent, in order. */
  readonly requests: RecordedRequest[] = [];
  /** CreateUserKey calls that stored a key. */
  created = 0;
  private failures = 0;
  private windowStart = 0;

  /** `now` is the server clock. */
  constructor(private readonly now: () => number = () => Date.now()) {}

  /** A transport to this server; each device can have its own. */
  readonly transport: Transport = recording(
    createRouterTransport(({ service }) => {
      service(UserKeyService, {
        getUserKeyParams: () => {
          const stored = this.require();
          return { publicKey: stored.publicKey, params: stored.params };
        },
        createUserKey: (request) => {
          if (request.publicKey.length !== 1216 || request.authKey.length !== 32 || request.params === undefined) {
            throw new ConnectError("invalid key", Code.InvalidArgument);
          }
          if (request.wrappedPrivateKey.length < 1 || request.wrappedPrivateKey.length > 256) throw new ConnectError("invalid wrapped key", Code.InvalidArgument);
          if (this.stored !== undefined) throw new ConnectError("the user already has a key", Code.AlreadyExists);
          this.stored = {
            publicKey: request.publicKey,
            wrappedPrivateKey: request.wrappedPrivateKey,
            params: request.params,
            authKeyHash: sha256(request.authKey),
          };
          this.created++;
          return {};
        },
        unlockUserKey: (request) => {
          if (request.authKey.length !== 32) throw new ConnectError("invalid auth key", Code.InvalidArgument);
          const stored = this.require();
          this.checkAttempt(request.authKey, stored);
          return {
            publicKey: stored.publicKey,
            wrappedPrivateKey: stored.wrappedPrivateKey,
            params: stored.params,
          };
        },
        changePassphrase: (request) => {
          if (request.authKey.length !== 32 || request.newAuthKey.length !== 32 || request.publicKey.length !== 1216 || request.newParams === undefined) {
            throw new ConnectError("invalid request", Code.InvalidArgument);
          }
          if (request.newWrappedPrivateKey.length < 1 || request.newWrappedPrivateKey.length > 256) throw new ConnectError("invalid wrapped key", Code.InvalidArgument);
          const stored = this.require();
          this.checkAttempt(request.authKey, stored);
          if (!request.publicKey.every((byte, index) => byte === stored.publicKey[index])) {
            throw new ConnectError("public_key is not the stored public key", Code.FailedPrecondition);
          }
          this.stored = {
            publicKey: stored.publicKey,
            wrappedPrivateKey: request.newWrappedPrivateKey,
            params: request.newParams,
            authKeyHash: sha256(request.newAuthKey),
          };
          return {};
        },
      });
    }),
    this.requests,
  );

  private require(): StoredKey {
    if (this.stored === undefined) throw new ConnectError("no key", Code.NotFound);
    return this.stored;
  }

  private checkAttempt(authKey: Uint8Array, stored: StoredKey): void {
    const now = this.now();
    if (this.failures > 0 && now >= this.windowStart + ATTEMPT_WINDOW_MS) this.failures = 0;
    if (this.failures >= MAX_FAILED_ATTEMPTS) {
      throw new ConnectError("too many failed attempts", Code.ResourceExhausted, undefined, [
        {
          desc: ErrorDetailSchema,
          value: {
            reason: ErrorReason.PASSPHRASE_ATTEMPTS_EXHAUSTED,
            retryTime: timestampFromDate(new Date(this.windowStart + ATTEMPT_WINDOW_MS)),
          },
        },
      ]);
    }
    const hash = sha256(authKey);
    if (!hash.every((byte, index) => byte === stored.authKeyHash[index])) {
      if (this.failures === 0) this.windowStart = now;
      this.failures++;
      throw new ConnectError("wrong passphrase", Code.PermissionDenied, undefined, [
        {
          desc: ErrorDetailSchema,
          value: { reason: ErrorReason.WRONG_PASSPHRASE },
        },
      ]);
    }
  }
}

/** `transport`, recording each unary request's serialized bytes into `requests`. */
function recording(transport: Transport, requests: RecordedRequest[]): Transport {
  return {
    unary: (method, signal, timeoutMs, header, input, contextValues) => {
      const schema: DescMessage = method.input;
      requests.push({
        procedure: method.name,
        bytes: toBinary(schema, create(schema, input)),
      });
      return transport.unary(method, signal, timeoutMs, header, input, contextValues);
    },
    stream: (method, signal, timeoutMs, header, input, contextValues) => transport.stream(method, signal, timeoutMs, header, input, contextValues),
  };
}
