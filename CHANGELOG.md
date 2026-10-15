# Changelog

All notable changes to `@nithin93/encrypted-share` are documented in this file.

## [3.1.0] - 2026-10-15

- New `-H, --host <address>` option on `serve`, `host` in the config file, and `host` on `startServer`. The server listens only on that address, for example `127.0.0.1` or a Tailscale IP, so other interfaces such as the local network cannot reach it. `--host` overrides the config file. Without it, the server still listens on all interfaces.
- The handle from `startServer` now includes the bound `host`.
- `serve` prints the bound address and port, for example `Server listening on 127.0.0.1:3000`. Without `--host` it shows the all-interfaces address, such as `[::]:3000`.
- README shows `--host` in the Tailscale FAQ and the CI artifacts recipe, and explains how to limit the Docker receiver to one host address with the port mapping instead.

## [3.0.1] - 2026-10-15

- Documentation only. The code is unchanged from 3.0.0.
- README gained badges (CI, npm version, downloads, license, types, Node.js), `npx` usage, and an FAQ entry on running over Tailscale.
- New README "Recipes" section: send a folder from a Node.js script with progress and exit codes, receive inside an Express app, back up a folder nightly with `cron`, send GitHub Actions artifacts over Tailscale, and receive in Docker.

## [3.0.0] - 2026-10-15

- Breaking: new wire protocol ES03. encrypted-share 3.x cannot talk to 2.x peers. A 3.x server answers a 2.x sender with an error that tells it to upgrade, and a 3.x sender against a 2.x server fails with `handshake-failed`.
- Breaking: library types changed. `TransferHeader` no longer has `salt` or `baseNonce`, and `ChunkHeader` is no longer exported.
- Every frame after a 22-byte hello is now encrypted and authenticated, including the file list and the server's resume and result messages. File names and SHA-256 hashes no longer appear on the wire. File count and per-file sizes can still be read from frame lengths.
- Each direction has its own key derived with HKDF-SHA256, and frames use a counter nonce. A forged "verified" result, an altered resume offset, or a dropped, reordered, or replayed frame now fails the transfer.
- The server mixes a random per-connection nonce into the keys, so a recorded transfer replayed to the server is rejected.
- The server runs one transfer at a time. When a new transfer authenticates, the server closes the unfinished one and logs `superseded an unfinished transfer`. Frames held back from an abandoned transfer can no longer land an old file over a newer one.
- New `idleTimeoutMs` option on `startServer` and `sendFiles`, default 60000. After that long with no activity, the connection closes and the transfer fails with `TransferError` code `timeout`.
- A wrong password now fails with `server closed the connection after the header; check that both sides use the same password`.
- `sealChunk` and `openChunk` take an optional `aad` argument. `openChunk` accepts only 16-byte tags.
- `encrypted-share --version` reads `package.json` with no hardcoded fallback.

## [2.0.1] - 2026-10-15

- Fix: `serve` now saves to the `outputDir` from the config file. Before, the `--out` default of `./received-files` always won, so the config value was ignored.
- The package no longer ships source maps (`dist/*.js.map`), which pointed at source files that were not in the package. The install is about 39 kB smaller.
- `CHANGELOG.md` is now included in the package.
- README rewritten: clearer opening, comparison with magic-wormhole, croc, scp/rsync and LocalSend, an FAQ, and an accurate security section. It now states that file names, sizes and hashes, and the server's result message, are not encrypted.
- CI now runs on Ubuntu, macOS and Windows.
- The release workflow skips `npm publish` when the version is already on npm.
- Package description and keywords updated.

## [2.0.0] - 2026-10-02

- From-scratch rewrite (v1 source lost).
- New ES02 wire protocol: manifest header, scrypt key derivation, per-chunk AES-256-GCM, SHA-256 verification, resume handshake, server RESULT confirmation.
- BREAKING: v2 protocol incompatible with v1.
- Hardening: verify-then-land, path sanitization, overwrite refusal by default, tar dependency removed.
- Features: progress bars, per-file checksums, resume.
- 57 tests with coverage gates, CI green on Node 22/24.
- repository.url uses the plain GitHub URL form (trusted publishing requires an exact match).
