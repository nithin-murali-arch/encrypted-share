# Changelog

All notable changes to `@nithin93/encrypted-share` are documented in this file.

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
