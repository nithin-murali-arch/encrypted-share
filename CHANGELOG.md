# Changelog

All notable changes to `@nithin93/encrypted-share` are documented in this file.

## [2.0.0] - 2026-10-02

- From-scratch rewrite (v1 source lost).
- New ES02 wire protocol: manifest header, scrypt key derivation, per-chunk AES-256-GCM, SHA-256 verification, resume handshake, server RESULT confirmation.
- BREAKING: v2 protocol incompatible with v1.
- Hardening: verify-then-land, path sanitization, overwrite refusal by default, tar dependency removed.
- Features: progress bars, per-file checksums, resume.
- 57 tests with coverage gates, CI green on Node 22/24.
