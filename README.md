# @nithin93/encrypted-share

[![CI](https://github.com/nithin-murali-arch/encrypted-share/actions/workflows/ci.yml/badge.svg)](https://github.com/nithin-murali-arch/encrypted-share/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@nithin93%2Fencrypted-share)](https://www.npmjs.com/package/@nithin93/encrypted-share)
[![npm downloads](https://img.shields.io/npm/dm/@nithin93%2Fencrypted-share)](https://www.npmjs.com/package/@nithin93/encrypted-share)
[![license](https://img.shields.io/npm/l/@nithin93%2Fencrypted-share)](https://github.com/nithin-murali-arch/encrypted-share/blob/main/LICENSE)
[![types](https://img.shields.io/npm/types/@nithin93%2Fencrypted-share)](https://www.npmjs.com/package/@nithin93/encrypted-share)
[![node](https://img.shields.io/node/v/@nithin93%2Fencrypted-share)](https://www.npmjs.com/package/@nithin93/encrypted-share)

`encrypted-share` is a command-line tool and Node.js library for sending files and folders between two machines over TCP. Everything after a short handshake, file names included, is encrypted and authenticated with AES-256-GCM and a shared password. It checks a SHA-256 hash for every file before the file lands, resumes interrupted transfers, has no native dependencies, and needs no third-party server or account.

Protocol details live in [DESIGN.md](DESIGN.md). Release notes are in [CHANGELOG.md](CHANGELOG.md).

## Install

```bash
npm install -g @nithin93/encrypted-share
```

Or run it without installing, with `npx`. Use the same major version on both machines, because 3.x cannot talk to 2.x:

```bash
npx @nithin93/encrypted-share@3 serve --port 3000 --key <password>
npx @nithin93/encrypted-share@3 send --target 192.0.2.10:3000 --key <password> ./data
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

- `-p, --port <number>`: port to listen on (default: `3000`).
- `-H, --host <address>`: local address to listen on, such as `127.0.0.1` or the machine's Tailscale IP (default: all network interfaces). `serve` prints the address and port it bound.
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

A JSON file (default: `~/.encrypted-share.json`) avoids retyping arguments. CLI flags override config values. Relative `outputDir` paths resolve against the current directory. `server` is the address `send` connects to. `host` is the local address `serve` listens on. Leave `host` out to listen on all network interfaces.

```json
{
  "key": "my-super-secret-password",
  "server": "localhost:3000",
  "port": 3000,
  "host": "127.0.0.1",
  "outputDir": "./downloads"
}
```

### Resume behavior

If a transfer is interrupted, re-run the same `send` command. The server reports how many bytes it already holds per file and the client sends only the remainder. Resume matches on exact path, size, and SHA-256, so changed files restart from zero. Partial state lives in `<out>/.es-partial/` and is removed once every file verifies.

## Library usage

```ts
import { startServer, sendFiles } from '@nithin93/encrypted-share';

const server = await startServer({ host: '127.0.0.1', port: 3000, password: 'pw', outDir: './in' });
await sendFiles({ host: '127.0.0.1', port: 3000, password: 'pw', path: './data' });
await server.close();
```

`startServer` listens on all network interfaces unless you pass `host`. It resolves with a handle that has the bound `host` and `port` and a `close()` method. `sendFiles` resolves with a report listing the files and bytes sent, and rejects with a `TransferError` on failure.

Both accept `idleTimeoutMs` (default `60000`). A side that receives nothing from its peer for that long closes the connection, and `sendFiles` rejects with code `timeout`.

## Recipes

Each recipe does one job. Replace the host names and `<password>` with your own.

### Send a folder from a Node.js script

To send a build or any other folder from a script, call `sendFiles` and turn `TransferError.code` into a message and an exit code.

```js
import { sendFiles, TransferError } from '@nithin93/encrypted-share';

const [target, dir = './dist'] = process.argv.slice(2);
const [host, port] = (target ?? '').split(':');
const password = process.env.ES_PASSWORD;
if (!host || !port || !password) {
  console.error('usage: ES_PASSWORD=<password> node send-build.mjs <host:port> [dir]');
  process.exit(1);
}

const failures = {
  'not-found': [1, `${dir} does not exist`],
  'connect-failed': [2, 'cannot reach the receiver; is encrypted-share serve running?'],
  'handshake-failed': [2, 'the receiver may run encrypted-share 2.x'],
  rejected: [2, 'the receiver refused the transfer'],
  timeout: [2, 'the receiver stopped responding'],
  'verify-failed': [2, 'the receiver could not verify every file'],
};

let lastTenth = -1;
try {
  const report = await sendFiles({
    host,
    port: Number(port),
    password,
    path: dir,
    onProgress: (sent, total) => {
      const tenth = total === 0 ? 10 : Math.floor((sent / total) * 10);
      if (tenth > lastTenth) console.log(`${tenth * 10}%`);
      lastTenth = tenth;
    },
  });
  console.log(`sent ${report.files.length} file(s), ${report.bytes} bytes`);
} catch (err) {
  if (!(err instanceof TransferError)) throw err;
  const [exitCode, hint] = failures[err.code] ?? [2, 'transfer failed'];
  console.error(`${hint} (${err.code}: ${err.message})`);
  process.exitCode = exitCode;
}
```

Save the script as `send-build.mjs` and run `ES_PASSWORD=<password> node send-build.mjs 192.0.2.10:3000 ./dist`. Like the CLI, it exits with `1` for a missing folder and `2` for a failed transfer.

### Receive files inside an existing Node.js app

To accept transfers in a process that already serves HTTP, call `startServer` next to your Express app and close both on `SIGINT` and `SIGTERM`.

```js
import express from 'express';
import { startServer } from '@nithin93/encrypted-share';

if (!process.env.ES_PASSWORD) throw new Error('set ES_PASSWORD');

const app = express();
app.get('/health', (req, res) => res.send('ok'));
const http = app.listen(8080);

const receiver = await startServer({
  port: 3000,
  password: process.env.ES_PASSWORD,
  outDir: './uploads',
  onTransfer: (msg) => console.log(`[encrypted-share] ${msg}`),
});
console.log(`HTTP on 8080, encrypted-share on ${receiver.port}`);

async function shutdown(signal) {
  console.log(`${signal}: closing`);
  await Promise.all([receiver.close(), new Promise((resolve) => http.close(resolve))]);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
```

`onTransfer` receives the messages that `encrypted-share serve` prints, such as `transfer complete: 2 file(s) verified`. The receiver listens on its own TCP port, 3000 here, and not on the Express port.

### Back up a folder every night

To copy a folder to another machine every night, keep the password in a config file and run `send` from `cron` on Linux or macOS.

On the sending machine, create `~/.encrypted-share-backup.json` in a text editor, so the password stays out of your shell history. Then run `chmod 600 ~/.encrypted-share-backup.json`.

```json
{
  "key": "<password>",
  "server": "backup-host:3000"
}
```

Run `crontab -e` and add the two lines below. Cron starts jobs with a short `PATH`, so the first line must include the directories that hold `node` and `npx`. Run `command -v node npx` to find them.

```text
PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin
30 2 * * * npx --yes @nithin93/encrypted-share@3 send --config "$HOME/.encrypted-share-backup.json" "$HOME/notes" >> "$HOME/encrypted-share-backup.log" 2>&1
```

Each run sends the whole folder again, so start the receiver with `serve --overwrite`, or the second night fails with `already exists (use --overwrite)`. If a run fails partway, the receiver keeps the bytes it got, and the next run [resumes](#resume-behavior) with only the rest.

### Send CI artifacts to a machine on your tailnet

To copy build output from GitHub Actions to a machine on your Tailscale tailnet, join the tailnet with `tailscale/github-action` and run `send` with the password from a repository secret.

```yaml
name: Ship build
on:
  push:
    branches: [main]

jobs:
  ship:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm run build
      - uses: tailscale/github-action@v4
        with:
          oauth-client-id: ${{ secrets.TS_OAUTH_CLIENT_ID }}
          oauth-secret: ${{ secrets.TS_OAUTH_SECRET }}
          tags: tag:ci
          ping: my-desktop.my-tailnet.ts.net
      - run: npx --yes @nithin93/encrypted-share@3 send --target my-desktop.my-tailnet.ts.net:3000 --key "$ES_PASSWORD" ./dist
        env:
          ES_PASSWORD: ${{ secrets.ES_PASSWORD }}
```

The [tailscale/github-action README](https://github.com/tailscale/github-action#readme) explains how to create the OAuth client for `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_SECRET`. Your tailnet's access rules must let `tag:ci` reach TCP port 3000 on the receiver, and the receiver needs `serve --overwrite` because every run sends the same file names. Start the receiver on its Tailscale address only, so its local network cannot reach the port:

```bash
npx @nithin93/encrypted-share@3 serve --host "$(tailscale ip -4)" --port 3000 --key <password> --overwrite
```

### Transfer on a network with no internet access

Use Node.js 20 or later on both machines. On a connected machine, build and pack this checkout. The resulting tarball bundles its runtime dependencies.

```sh
npm ci
npm run build
npm pack
```

Published 3.0.1 and earlier tarballs do not bundle their dependencies. Downloading those tarballs with `npm pack @nithin93/encrypted-share` alone is not enough for an offline installation with an empty cache. After a release containing this packaging change, you can download that release with `npm pack @nithin93/encrypted-share@<version>`.

Copy `nithin93-encrypted-share-3.x.y.tgz` to each machine with removable media. Replace `3.x.y` with the version in the filename. Install without contacting the registry.

```sh
npm install --offline -g ./nithin93-encrypted-share-3.x.y.tgz
```

Start the receiver, then send from the other machine using the receiver's LAN address.

```sh
# Receiver
encrypted-share serve --port 3000 --key 'your-shared-password' --out ./received
# Sender
encrypted-share send ./dataset --target 192.168.1.20:3000 --key 'your-shared-password'
```

The sender must reach the receiver's TCP port. Allow it through the LAN firewall. No relay, DNS service, or internet connection is required when you use a LAN IP address. Both machines must use 3.x. Protocol 3.x cannot communicate with 2.x.

Run `node examples/offline-install/verify.mjs ./nithin93-encrypted-share-3.x.y.tgz` from this checkout to verify installation with a fresh prefix and an empty npm cache.

### Receive files in Docker

To run the receiver on a host that has Docker but not Node.js, run `npx` in the official `node:22-alpine` image and mount the output directory.

```bash
docker run --rm -p 3000:3000 -v "$PWD/received:/data" \
  node:22-alpine npx --yes @nithin93/encrypted-share@3 serve --port 3000 --key <password> --out /data
```

Received files land in `./received` on the host. Ctrl+C stops the container, and because `--rm` deletes it, the next start downloads the package again.

Do not pass `--host` inside the container, because the container has its own network interfaces. To limit which host address accepts transfers, put that address in the port mapping instead, for example `-p 100.64.0.5:3000:3000` for a Tailscale IP or `-p 127.0.0.1:3000:3000` for local use only.

## Security notes

- Passwords are stretched with scrypt (N=16384, r=8, p=1) and a random 128-bit salt per transfer. Anyone who records a transfer can test password guesses offline, at the cost of one scrypt per guess, so use a long random password, unique per sharing peer.
- After a 22-byte hello in each direction, every frame is encrypted and authenticated with AES-256-GCM. That covers the file list, the server's resume and result messages, and the file data, so file names, SHA-256 hashes, and file contents are hidden from the network.
- Each direction has its own key, and the nonce is a frame counter. A tampered, dropped, reordered, or replayed frame aborts the transfer, and a forged result message fails authentication, so "Verified by server" holds against an active attacker who does not know the password.
- No file appears at its final path until its SHA-256 matches the sender's. Data that has passed frame authentication but not the hash check waits in `<out>/.es-partial/`. Directories listed in the transfer are created before the files in them verify.
- The server picks a random nonce for every connection and mixes it into the keys. A recorded transfer replayed to the server fails on its first frame.
- The server runs one transfer at a time. When a new transfer authenticates, the server closes any unfinished one, which then cannot write or land files. Frames an attacker held back from an abandoned transfer therefore cannot overwrite a file sent later.
- Sizes stay visible. Frame lengths are not encrypted, and every file starts a new chunk, so an observer can work out the file count, each file's size, the combined length of the file names (from the size of the file list), and the total volume and timing.
- This is a pre-shared-key tool. There is no forward secrecy and no peer authentication beyond the shared password. Anyone who knows the password can send files to your server, and anyone who records a transfer and later learns the password can decrypt it.
- encrypted-share 3.x speaks wire protocol ES03 and cannot talk to 2.x peers. A 3.x server tells a 2.x sender to upgrade. A 3.x sender against a 2.x server fails with a handshake error.
- Only run `serve` on networks you trust, or tunnel it (SSH or WireGuard).
- The server has no connection cap. Every incoming hello costs it one scrypt run (about 19 ms) before the peer proves it knows the password, and it buffers up to 4 MiB of file list per connection. This is unchanged from 2.x.
- Files named `__proto__`, or with a name that starts with `..`, cannot be transferred. This is unchanged from 2.x.

## When to use it

- You control both machines, can install Node.js on both, and the receiver's port is reachable from the sender (same LAN, VPN, or a forwarded port).
- You want one command that sends a folder, verifies every file, and can pick up where an interrupted transfer stopped.
- You want to call the transfer from a Node.js program with `startServer` and `sendFiles`.
- Machines on different networks work when both are on the same Tailscale tailnet or another VPN. Without a VPN and without port forwarding, the connection never opens, because the tool has no relay and no NAT traversal of its own. Use croc or magic-wormhole in that case.
- Do not use it when you need to hide how much data you send or how large each file is, or when you need forward secrecy or a stronger identity check than a shared password. See the security notes.

## Alternatives

| Tool | Interface | Needs a relay or rendezvous server | Works across NAT without port forwarding | Needs an account on the other machine | Install |
| --- | --- | --- | --- | --- | --- |
| `encrypted-share` | CLI, Node.js library | No | Only over a VPN such as Tailscale (otherwise the receiver's port must be reachable) | No | npm, or `npx` with no install |
| magic-wormhole | CLI, Python library | Yes (rendezvous server, transit relay as fallback) | Yes | No | pip |
| croc | CLI | Yes (relay server) | Yes | No | Single Go binary |
| scp or rsync over SSH | CLI | No | No (SSH port must be reachable) | Yes (SSH login) | Preinstalled on most Unix systems |
| LocalSend | GUI app | No | No (local network discovery) | No | App installers |

magic-wormhole and croc are the better choice for two machines on different networks that do not share a VPN, because they connect through a server and need no port forwarding. `rsync` over SSH is the better choice when you already have SSH access, because it needs no extra software. LocalSend is the better choice when you want a graphical app on a local network. `encrypted-share` fits when both ends can run Node.js, the receiver's port is reachable, and you want no third-party server or account in the path.

## FAQ

### How do I send files between two computers securely from the command line?

Run `encrypted-share serve` on the receiver and `encrypted-share send` on the sender with the same `--key`. The sender connects to the receiver's address and port. File names, hashes, and contents are encrypted with AES-256-GCM before they leave the sender. File sizes and the file count can be read from the frame lengths.

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

It works anywhere the sender can open a TCP connection to the receiver's port, which includes the internet. It has no relay and no NAT traversal, so a receiver behind NAT needs a forwarded port, a VPN such as Tailscale, or an SSH tunnel. If neither machine can accept inbound connections and you cannot use a VPN, use croc or magic-wormhole.

### Does it work over Tailscale?

Yes. By default `serve` listens on every network interface, including the Tailscale one, and `send` connects to whatever address `--target` names. Put both machines on the same tailnet and use the receiver's Tailscale IP or MagicDNS name. Tailscale handles NAT traversal, so no port forwarding is needed.

```bash
# on the receiver (MagicDNS name: my-desktop)
npx @nithin93/encrypted-share@3 serve --port 3000 --key <password>

# on the sender, from any network
npx @nithin93/encrypted-share@3 send --target my-desktop:3000 --key <password> ./data
```

To accept transfers only over the tailnet, pass the receiver's Tailscale IP to `--host`. `serve` then listens on that address alone, so devices on the receiver's local network or the public internet cannot reach the port at all, password or not.

```bash
# on the receiver: listen only on its Tailscale IPv4 address
npx @nithin93/encrypted-share@3 serve --host "$(tailscale ip -4)" --port 3000 --key <password>
```

If your tailnet uses access control rules, they must allow the sender to reach TCP port 3000 on the receiver. Tailscale encrypts the link with WireGuard. `encrypted-share` adds its own password-based encryption, a SHA-256 check on every file, and resume on top of that. Without `--host`, `serve` also accepts connections from the receiver's local network, and the password is what keeps other devices out.

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
