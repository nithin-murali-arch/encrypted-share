# @nithin93/encrypted-share

[![CI](https://github.com/nithin-murali-arch/encrypted-share/actions/workflows/ci.yml/badge.svg)](https://github.com/nithin-murali-arch/encrypted-share/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@nithin93%2Fencrypted-share.svg)](https://www.npmjs.com/package/@nithin93/encrypted-share)

`encrypted-share` is a command-line tool and Node.js library for sending files and folders between two machines over TCP. Everything after a short handshake, file names included, is encrypted and authenticated with AES-256-GCM and a shared password. It checks a SHA-256 hash for every file before the file lands, resumes interrupted transfers, has no native dependencies, and needs no third-party server or account.

Protocol details live in [DESIGN.md](DESIGN.md). Release notes are in [CHANGELOG.md](CHANGELOG.md).

## Install

```bash
npm install -g @nithin93/encrypted-share
```

Node.js 20 or later is required (the `engines` field). To run from source:

```bash
git clone https://github.com/nithin-murali-arch/encrypted-share.git
cd encrypted-share
npm install
npm run build
node dist/cli.js --help
```

## Quick start

On the receiving machine:

```bash
encrypted-share serve --port 3000 --key <password> --out ./received-files
```

On the sending machine, with the receiver's address and the same password:

```bash
encrypted-share send --target 192.0.2.10:3000 --key <password> ./data
```

The sender prints `Verified by server` when the receiver has checked every file. `serve` keeps running until you stop it.

## Features

- AES-256-GCM on every frame after the handshake: the file list, the server's replies, and the file data. Keys come from the password through scrypt and HKDF, with a fresh random salt per transfer and a fresh server nonce per connection.
- Per-file SHA-256 verification. The server writes a file to the output directory only after its hash matches the manifest, then reports the result to the client.
- Resume. A re-run of an interrupted `send` continues from the bytes the server already holds.
- Files and folders, including empty files and empty directories. Symlinks are skipped with a warning.
- Live byte progress bar on every send.
- No native dependencies, and no file size limit in the code. Files are read and written in 64 KiB chunks, so memory use does not grow with file size.
- Runs on Windows, macOS, and Linux. CI builds and tests on all three with Node.js 22 and 24.
- Written in TypeScript. The package ships its own type declarations.

## Usage

### Start the server (receiver)

```bash
encrypted-share serve --port 3000 --key <your-secret-key> --out ./received-files
```

Options:

- `-p, --port <number>`: port to listen on (default: `3000`). `serve` listens on all network interfaces.
- `-k, --key <string>`: encryption password (required).
- `-o, --out <path>`: directory to save received files (default: `./received-files`).
- `-c, --config <path>`: path to a JSON config file.
- `--overwrite`: allow overwriting existing files (default: refuse).

### Send files (sender)

```bash
encrypted-share send --target localhost:3000 --key <your-secret-key> ./path/to/files
```

The path defaults to the current directory. Options:

- `-t, --target <host:port>`: server address (required).
- `-k, --key <string>`: encryption password (required, must match the server).
- `-c, --config <path>`: path to a JSON config file.

Exit codes: `0` success, `1` usage or config error, `2` transfer failed.

### Configuration file

A JSON file (default: `~/.encrypted-share.json`) avoids retyping arguments. CLI flags override config values. Relative `outputDir` paths resolve against the current directory.

```json
{
  "key": "my-super-secret-password",
  "server": "localhost:3000",
  "port": 3000,
  "outputDir": "./downloads"
}
```

### Resume behavior

If a transfer is interrupted, re-run the same `send` command. The server reports how many bytes it already holds per file and the client sends only the remainder. Resume matches on exact path, size, and SHA-256, so changed files restart from zero. Partial state lives in `<out>/.es-partial/` and is removed once every file verifies.

## Library usage

```ts
import { startServer, sendFiles } from '@nithin93/encrypted-share';

const server = await startServer({ port: 3000, password: 'pw', outDir: './in' });
await sendFiles({ host: '127.0.0.1', port: 3000, password: 'pw', path: './data' });
await server.close();
```

`startServer` resolves with a handle that has the bound `port` and a `close()` method. `sendFiles` resolves with a report listing the files and bytes sent, and rejects with a `TransferError` on failure.

## Security notes

- Passwords are stretched with scrypt (N=16384, r=8, p=1) and a random 128-bit salt per transfer. Use a long, unique password per sharing peer.
- After a 22-byte hello in each direction, every frame is encrypted and authenticated with AES-256-GCM. That covers the file list, the server's resume and result messages, and the file data, so file names, sizes, and SHA-256 hashes are hidden from the network.
- Each direction has its own key, and the nonce is a frame counter. A tampered, dropped, reordered, or replayed frame aborts the transfer, and a forged result message fails authentication, so "Verified by server" holds against an active attacker who does not know the password. Nothing unverified is written to the output directory. Files land atomically after checksum verification.
- The server picks a random nonce for every connection and mixes it into the keys. A recorded transfer replayed to the server fails on its first frame.
- The total transfer size and its timing remain visible from the traffic volume.
- This is a pre-shared-key tool. There is no forward secrecy and no peer authentication beyond the shared password. Anyone who knows the password can send files to your server, and anyone who records a transfer and later learns the password can decrypt it.
- encrypted-share 3.x speaks wire protocol ES03 and cannot talk to 2.x peers. A 3.x server tells a 2.x sender to upgrade. A 3.x sender against a 2.x server fails with a handshake error.
- Only run `serve` on networks you trust, or tunnel it (SSH or WireGuard).

## When to use it

- You control both machines, can install Node.js on both, and the receiver's port is reachable from the sender (same LAN, VPN, or a forwarded port).
- You want one command that sends a folder, verifies every file, and can pick up where an interrupted transfer stopped.
- You want to call the transfer from a Node.js program with `startServer` and `sendFiles`.
- Do not use it for machines on different networks behind NAT with no port forwarding. The tool has no relay and no NAT traversal, so the connection never opens. Use croc or magic-wormhole instead.
- Do not use it when you need to hide how much data you send, or when you need forward secrecy or a stronger identity check than a shared password. See the security notes.

## Alternatives

| Tool | Interface | Needs a relay or rendezvous server | Works across NAT without port forwarding | Needs an account on the other machine | Install |
| --- | --- | --- | --- | --- | --- |
| `encrypted-share` | CLI, Node.js library | No | No (receiver's port must be reachable) | No | npm |
| magic-wormhole | CLI, Python library | Yes (rendezvous server, transit relay as fallback) | Yes | No | pip |
| croc | CLI | Yes (relay server) | Yes | No | Single Go binary |
| scp or rsync over SSH | CLI | No | No (SSH port must be reachable) | Yes (SSH login) | Preinstalled on most Unix systems |
| LocalSend | GUI app | No | No (local network discovery) | No | App installers |

magic-wormhole and croc are the better choice for two machines on different networks, because they connect through a server and need no port forwarding. `rsync` over SSH is the better choice when you already have SSH access, because it needs no extra software. LocalSend is the better choice when you want a graphical app on a local network. `encrypted-share` fits when both ends can run Node.js, the receiver's port is reachable, and you want no third-party server or account in the path.

## FAQ

### How do I send files between two computers securely from the command line?

Run `encrypted-share serve` on the receiver and `encrypted-share send` on the sender with the same `--key`. The sender connects to the receiver's address and port. File names, sizes, and contents are encrypted with AES-256-GCM before they leave the sender.

```bash
encrypted-share serve --port 3000 --key <password>
encrypted-share send --target 192.0.2.10:3000 --key <password> ./report.pdf
```

### How do I transfer a folder encrypted over the network?

Pass the folder as the `send` path. The whole tree is sent, including empty files and empty directories, and the server recreates it under its output directory. Symlinks are skipped with a warning.

```bash
encrypted-share send --target 192.0.2.10:3000 --key <password> ./project-folder
```

### Can it resume an interrupted transfer?

Yes. Re-run the same `send` command and the server reports how many bytes it already holds for each file. Resume only applies to files with the same path, size, and SHA-256. The code enforces no file size limit, so resume is useful for large files.

### Does it work across the internet or only on a LAN?

It works anywhere the sender can open a TCP connection to the receiver's port, which includes the internet. It has no relay and no NAT traversal, so a receiver behind NAT needs a forwarded port, a VPN, or an SSH tunnel. If neither machine can accept inbound connections, use croc or magic-wormhole.

### How is the key derived from the password?

The client computes `scrypt(password, salt, 32 bytes)` with N=16384, r=8, p=1. It generates a fresh random 16-byte salt for each transfer and sends it in its hello. The server answers with a random 16-byte nonce. HKDF-SHA256 turns the scrypt output, the salt, and the server nonce into one key per direction. Every frame then gets its own AES-256-GCM nonce from a counter.

### What happens if the password is wrong?

The transfer fails before any file data is sent, and nothing lands in the output directory. `send` exits with code `2` and prints `server closed the connection after the header; check that both sides use the same password`. The server logs `transfer failed: frame authentication failed`.

### How does it compare to croc or magic-wormhole?

croc and magic-wormhole connect two machines through a relay or rendezvous server, so they work when both sides are behind NAT. `encrypted-share` connects directly and uses no third-party server, but the receiver's port must be reachable. See the [alternatives table](#alternatives).

### Can I use it as a library in Node.js?

Yes. Import `startServer` and `sendFiles` from the package, which ships TypeScript declarations. See [Library usage](#library-usage).

## Supported environments

Node.js 20 or later is required (the `engines` field). CI runs build, lint, and tests on Ubuntu, macOS, and Windows with Node.js 22 and 24, so other Node.js versions are untested.

## Development

```bash
npm install
npm run build    # tsc
npm test         # jest (unit, CLI, and TCP loopback e2e)
npm run lint     # eslint
```

Releases are cut by pushing a tag (`git tag v3.x.y && git push --tags`). CI builds, tests, and publishes to npm with provenance. npm trusted publishing (OIDC) must be configured once for the package.

## License

MIT
