# Verified modules (Dafny)

Code in `plugin/verified/` is written in [Dafny](https://dafny.org) and carries machine-checked proofs: preconditions (`requires`), postconditions (`ensures`), invariants. It is the planned home of the sync engine's decision core (#946 is the feasibility gate). For now only a toy module exists, `Clamp.dfy`.

## Toolchain

The flake's dev shell provides Dafny from nixpkgs (4.11.0 at the time of writing), pinned by `flake.lock`, together with the .NET runtime and the z3 solver it runs on. Nothing else needs installing.

## Commands

- `make verify` runs `dafny verify plugin/verified/*.dfy`. A proof that does not go through fails it. CI's `verify` job runs it on every push to `master` and on PRs that change `plugin/verified/**`, `flake.nix`/`flake.lock`, `.github/workflows/ci.yml` or `.github/actions/nix-dev-shell/`. The job is part of the required `checks`.
- `make verified-js` (`scripts/verified-js.sh`) compiles the modules, with the Dafny JavaScript runtime included, to one CommonJS file, `plugin/src/verified/gen/verified.cjs`. `make build` (`make plugin-build`) runs it first. The file is committed like the protobuf code, so builds without Dafny still work (the native Windows and macOS e2e legs run `npm run build` directly). `make check-generate` (CI's lint job) fails when the committed file differs from a fresh compile. Compiling does not run the verifier again: `make verify` is the proof check.

## Using a module from the plugin

Dafny emits no TypeScript declarations. `plugin/src/verified/gen/verified.d.cts` declares, by hand, the parts of the compiled code that the wrappers use. Each wrapper in `plugin/src/verified/` (for example `clamp.ts`) converts between TypeScript and Dafny values (a Dafny `int` is a `BigNumber` from `bignumber.js`, which the runtime requires) and checks the function's `requires` clauses before calling it, because compiled Dafny does not check them. The plugin exposes the wrappers as `plugin.verified` so the e2e spec `test/e2e/specs/verified.e2e.ts` can call the compiled code inside Obsidian, on desktop, on emulated mobile and on the Android app.

The Dafny runtime sets `bignumber.js`'s global `MODULO_MODE` to `EUCLID` when it loads. Other plugin code that uses `bignumber.js` must not rely on its default modulo mode.

## Cost

Measured for #946 (Dafny 4.11.0, toy module): the runtime adds about 54 KB to the minified `main.js` (about 21 KB gzipped). `make verify` and `make verified-js` each take under a second once the dev shell is loaded. The Dafny closure (the .NET 8 SDK and z3) adds about 870 MB to the dev shell's Nix store, which every Linux CI job restores from the Nix cache.
