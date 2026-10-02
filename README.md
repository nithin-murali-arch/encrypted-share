# Encrypted Share CLI

Secure file sharing over TCP with AES-256-GCM. Transfers resume with checksums.

[![CI](https://github.com/nithin-murali-arch/encrypted-share/actions/workflows/ci.yml/badge.svg)](https://github.com/nithin-murali-arch/encrypted-share/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@nithin93%2Fencrypted-share.svg)](https://www.npmjs.com/package/@nithin93/encrypted-share)

Protocol details live in [DESIGN.md](DESIGN.md).

## Quick Start

```bash
npm install -g @nithin93/encrypted-share
```

```bash
encrypted-share serve --port 3000 --key <password> --out ./received-files
encrypted-share send --target 192.0.2.10:3000 --key <password> ./data
```

## Features

- **Authenticated encryption**: AES-256-GCM per chunk, scrypt key derivation
  with a fresh random salt per transfer.
- **Verified delivery**: per-file SHA-256 manifest; the server only lands
  files that verify, and reports a signed result back to the client.
- **Resume**: interrupted transfers continue from the last verified byte.
- **Progress bars**: live byte progress for every send.
- **Works for files and directories**, including empty files and empty dirs.
- **Cross-platform**: Windows, macOS, Linux. No native dependencies.

## Install

```bash
npm install -g @nithin93/encrypted-share
```

Or run from source:

```bash
git clone https://github.com/nithin-murali-arch/encrypted-share.git
cd encrypted-share
npm install
npm run build
node dist/cli.js --help
```

Requires Node.js 20+.

## Usage

### 1. Start the server (receiver)

```bash
encrypted-share serve --port 3000 --key <your-secret-key> --out ./received-files
```

Options:

- `-p, --port <number>`: port to listen on (default: `3000`).
- `-k, --key <string>`: encryption password (required).
- `-o, --out <path>`: directory to save received files (default: `./received-files`).
- `-c, --config <path>`: path to a JSON config file.
- `--overwrite`: allow overwriting existing files (default: refuse).

### 2. Send files (sender)

```bash
encrypted-share send --target localhost:3000 --key <your-secret-key> ./path/to/files
```

The path defaults to the current directory. Options:

- `-t, --target <host:port>`: server address (required).
- `-k, --key <string>`: encryption password (required, must match the server).
- `-c, --config <path>`: path to a JSON config file.

Exit codes: `0` success · `1` usage/config error · `2` transfer failed.

### Configuration file

A JSON file (default: `~/.encrypted-share.json`) avoids retyping arguments.
CLI flags override config values.

```json
{
  "key": "my-super-secret-password",
  "server": "localhost:3000",
  "port": 3000,
  "outputDir": "./downloads"
}
```

### Resume behavior

If a transfer is interrupted, re-run the same `send` command: the server
reports how many bytes it already holds per file and the client sends only
the remainder. Resume matches on exact path, size, and SHA-256 — changed
files restart from zero. Partial state lives in `<out>/.es-partial/` and is
removed once every file verifies.

## Security notes

- Passwords are stretched with scrypt (N=16384, r=8, p=1) and a random
  128-bit salt per transfer. Use a long, unique password per sharing peer.
- Each chunk carries a unique nonce and a 128-bit GCM auth tag; tampered
  chunks abort the transfer and nothing unverified is ever written to the
  output directory (files land atomically after checksum verification).
- This is a pre-shared-key tool: there is no forward secrecy and no peer
  authentication beyond the shared password. It protects file contents in
  transit against eavesdroppers, not against a malicious peer who knows
  the password.
- Only run `serve` on networks you trust, or tunnel it (SSH/WireGuard).

## Library usage

```ts
import { startServer, sendFiles } from '@nithin93/encrypted-share';

const server = await startServer({ port: 3000, password: 'pw', outDir: './in' });
await sendFiles({ host: '127.0.0.1', port: 3000, password: 'pw', path: './data' });
await server.close();
```

## Development

```bash
npm install
npm run build    # tsc
npm test         # jest (unit + TCP loopback e2e)
npm run lint     # eslint
```

Releases are cut by pushing a tag (`git tag v2.x.y && git push --tags`):
CI builds, tests, and publishes to npm with provenance. npm trusted
publishing (OIDC) must be configured once for the package.

## License

MIT
