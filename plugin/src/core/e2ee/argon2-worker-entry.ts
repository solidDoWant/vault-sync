/**
 * The entry point of the Argon2id Web Worker. scripts/argon2-worker.ts bundles
 * it into a script that the plugin inlines and ./argon2 starts from a Blob
 * URL. Each message is an Argon2idInput; the answer is an
 * Argon2WorkerResponse.
 */
import { answerArgon2Request, type Argon2idInput, type Argon2WorkerResponse } from "./argon2-wasm";

interface WorkerScope {
  onmessage: ((event: { data: Argon2idInput }) => void) | null;
  postMessage(message: Argon2WorkerResponse): void;
}

const scope = globalThis as unknown as WorkerScope;
scope.onmessage = (event) => {
  void answerArgon2Request(event.data).then((response) => {
    scope.postMessage(response);
  });
};
