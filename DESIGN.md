# encrypted-share design

encrypted-share 2.0 was a fresh rewrite (v1 source lost; v1.0.0 behavior
recovered from the published `dist/` and used as the behavioral baseline),
with the same CLI verbs and config shape as v1 and a new wire protocol, ES02.
encrypted-share 3.0 replaces ES02 with ES03, which encrypts and authenticates
every frame after the hello. 3.x and 2.x peers cannot talk to each other.

## Why a new protocol (v1 post-mortem)

- `tar-fs.pack(filePath)` emits a single entry named `"."` → single-file
  send always failed server-side with `EISDIR`. Directory mode worked.
- Key stretch was raw `SHA256(password)`, with no salt and no KDF.
- Plaintext hit the output dir *during* streaming decrypt; the GCM tag was
  only verified at end-of-stream. Tampered bytes could land partial files.
- No integrity manifest: client never learned whether the server got the
  bytes intact (no RESULT message).
- Resume/progress/per-file checksums (v2 scope) cannot bolt onto a single
  opaque tar stream without re-implementing chunking anyway.

## Candidates considered

**A. Framed archive stream (v1-shaped, fixed).** Keep one tar-over-GCM
stream; fix file-pack by wrapping single files; prepend `MAGIC+salt+IV`,
append a manifest checksum. Smallest code. Rejected: resume needs random
access into an authenticated stream, which is impossible without chunk keys,
so A would grow a second mechanism and become B with extra steps (temporal
decomposition smell).

**B. Chunked framed protocol with manifest (chosen).** Header manifest +
independently-authenticated chunks + resume handshake. Each v2 requirement
maps to exactly one mechanism: resume→offset handshake, progress→chunk
counting, checksums→manifest + per-chunk tags. Wire complexity concentrates
in `protocol.ts` (deep module, narrow interface); `server`/`client` stay thin.

## Why ES03

ES02 encrypted only the file chunks. These parts crossed the wire in clear
and unauthenticated:

- the header JSON with file names, sizes, and SHA-256 hashes,
- the server's RESUME and RESULT messages,
- each chunk frame's `fileIndex` and `offset`, which the GCM tag did not cover.

An eavesdropper could read the names and sizes of the files. A man in the
middle could forge a RESULT of `{ok:true}`, and the client then printed
"Verified by server". The same attacker could change the RESUME offsets so
the client skipped data, or replay a captured transfer to the server. With
`--overwrite`, a replay could revert files to an older version.

## Wire protocol ES03 (TCP, client speaks first, big-endian)

```
CLIENT_HELLO := MAGIC('ES03') VERSION(u16=3) clientSalt(16)      client -> server
SERVER_HELLO := MAGIC('ES03') VERSION(u16=3) serverNonce(16)     server -> client

SEALED    := LEN(u32) ciphertext tag(16)            LEN = ciphertext length + 16
plaintext := TYPE(u8) BODY
nonce     := 12-byte big-endian counter, per direction, starting at 0, +1 per frame
AAD       := MAGIC || VERSION(u16)
```

Every frame after the two hellos is a `SEALED` frame.

| TYPE | Name | Direction | BODY |
|---|---|---|---|
| 1 | HEADER | client to server | JSON `{chunkSize, files:[{path,size,sha256}], dirs:[]}` |
| 2 | RESUME | server to client | JSON `{received:{[path]:bytes}, error?}` |
| 3 | CHUNK | client to server | `fileIndex(u32) offset(u64) data` |
| 4 | DONE | client to server | empty |
| 5 | RESULT | server to client | JSON `{ok, verified:[], failed:[{path,reason}]}` |

The sequence is fixed: HEADER, RESUME, zero or more CHUNK, DONE, RESULT. The
receiver rejects any other TYPE with `TransferError('bad-frame')`. After
RESUME, the server accepts CHUNK or DONE. That is the only point where two
types are valid.

### Keys

- The client generates a random 16-byte `clientSalt` per transfer. The server
  generates a random 16-byte `serverNonce` per connection.
- `ikm = scrypt(password, clientSalt, 32, {N:16384, r:8, p:1})` (`deriveKey`).
- `deriveSessionKeys` derives two 32-byte keys with HKDF-SHA256 over `ikm`,
  salted with `clientSalt || serverNonce`. The info strings are
  `ES03 client->server` and `ES03 server->client`.

### What the design guarantees

- Each direction has its own key, so the two counters never produce the same
  key and nonce pair.
- The nonce is an implicit counter. A dropped, reordered, duplicated, or
  replayed frame fails authentication. DONE is sealed, so a truncated
  transfer is detected.
- The server nonce feeds both keys. A recorded session replayed to the server
  fails on the first sealed frame, because the server picked a new nonce.
- `fileIndex` and `offset` sit inside the authenticated plaintext.
- Any authentication failure, on either side, throws
  `TransferError('decrypt-failed')`.

### What stays visible on the wire

File names, hashes, and contents are hidden. The hellos, the frame lengths,
and the timing are not. The hellos are 22 bytes each. Every sealed frame adds
21 bytes (`LEN`, `TYPE`, tag), so a CHUNK frame carries 33 bytes beyond its
file data (ES02 used 36).

The client starts a new chunk for every file, so each file ends in a frame
shorter than `chunkSize` unless its size is an exact multiple. From the CHUNK
frame lengths an observer recovers the file count and each file's size. With
those, the HEADER frame length gives the combined length of the file names.
The total volume is visible too. A review probe recovered
`100000,5,70000,131072` exactly from one transfer. ES03 does not pad.

### One transfer at a time

Every transfer writes to the same `<out>/.es-partial/`. In ES03 as first
written, a man in the middle could relay session A's HEADER, hold back its
CHUNK and DONE frames, wait for the user to send a newer version as session B,
and then release A's frames. The server, which never timed out, landed A's old
file over B's under `--overwrite`.

`startServer` now tracks one active session, the connection whose HEADER most
recently authenticated. When a new HEADER authenticates, the server destroys
the previous active connection before `store.prepare` and logs
`superseded an unfinished transfer`. A session checks that it is still the
active one after every CHUNK or DONE frame and before it appends or lands.
If it is not, it stops with `TransferError('superseded')` and lands nothing.
Only an authenticated session can take over, so an outsider without the
password cannot cut off a transfer.

Both sides also close a connection after `idleTimeoutMs` (default 60 s) with
no activity, through `socket.setTimeout`, and fail with
`TransferError('timeout', 'no data from the peer for <n> s')`. This also ends
unauthenticated connections that stall partway through a frame. The timer is
suspended while the receiver hashes from disk, because no bytes flow then:
around `PartialStore.prepare` and `verifyAndLand` on the server, and while the
client waits for RESUME and RESULT. A slow hash would otherwise fail the
sender with `timeout` after the receiver had already landed the files.

### Unchanged from ES02

- Chunks for a file must arrive contiguous (`offset == receivedBytes`),
  else the server aborts.
- The server verifies each frame's GCM tag on receipt, then the per-file
  SHA-256 over the plaintext at DONE, then renames temp to final. `RESULT.ok`
  is the client's only success signal.
- Resume: the server persists `.es-partial/state.json` and one temp file per
  manifest path in the out dir. On a new transfer it reports received bytes
  per identical `(path,size,sha256)` file, and the client skips ahead.
- Paths are sanitized: no absolute paths, `..` segments, drive letters, NUL.
  Existing finals are refused unless `--overwrite` (serve side).
- Size limits on the server's read side: `MAX_MESSAGE_BYTES` (4 MiB) for JSON
  frames, `chunkSize + 29` bytes for chunk frames.

### Errors and old peers

| Situation | What happens |
|---|---|
| ES02 sender, 3.x server | The server reads the `ES02` prefix and the rest of the old header, answers with an ES02-format RESUME (`LEN(u32) JSON {received:{}, error}`) that says the server runs encrypted-share 3 and the sender must upgrade, then closes. The 2.x sender prints `server rejected transfer: <error>`. |
| Unknown magic or version | The server closes the connection and logs the reason, for example `unknown protocol magic "GET "`. |
| 3.x sender, ES02 server | The old server closes on the bad magic. The sender fails with `handshake-failed`. |
| Wrong password | The server cannot open HEADER, logs `transfer failed: frame authentication failed: ...`, and closes. The sender fails with `rejected` and a message that asks to check the password. |

### Known limits

- Each unauthenticated hello costs the server one synchronous scrypt run
  (about 19 ms) and up to 4 MiB of buffered HEADER. There is no connection
  cap. Same as 2.x.
- Files named `__proto__`, or with a name that starts with `..`, cannot be
  transferred. Same as 2.x.
- Anyone who records a transfer can test password guesses offline at one
  scrypt run per guess. Only a long random password defends against this.

## Module map

| Module | Owns | Touches |
|---|---|---|
| `protocol.ts` | MAGIC/VERSION, hello encode/decode, frame TYPE enum and typed frame model, body codecs (header JSON + shape check, chunk body, message JSON), ES02 rejection frame, `sanitizePath`, `FrameReader` | nothing (pure) |
| `channel.ts` | drain-aware writes, exact/frame reads over a socket, idle timeout (shared by client, server, tests) | `net`, `protocol` |
| `secure-channel.ts` | `SecureChannel`: per-direction key and counter, `send(type, body)`, `recv(expectedTypes)` | `channel`, `crypto`, `protocol` |
| `crypto.ts` | `deriveKey`, `deriveSessionKeys`, `sealChunk`/`openChunk` (optional AAD), `sha256File`, random salt and server nonce | `node:crypto`, `fs` (hash only) |
| `manifest.ts` | walk file-or-dir → `{files, dirs}`, skip symlinks w/ warning | `fs`, `crypto.ts` |
| `store.ts` | receiver-side partial state: load/save, contiguity-checked append, `verify`, atomic `land`, overwrite policy | `fs` |
| `server.ts` | `net` server: hello (or ES02 rejection) → HEADER → RESUME → chunk loop → RESULT; one transfer per connection, one active transfer per server | `protocol`, `crypto`, `secure-channel`, `store` |
| `client.ts` | connect → hello → HEADER → skip received → CHUNK frames with progress callback → DONE → RESULT | `protocol`, `crypto`, `secure-channel`, `manifest` |
| `config.ts` | v1-compatible JSON config (`key/server/port/outputDir`, default `~/.encrypted-share.json`) | `fs` |
| `cli.ts` | commander `serve`/`send`, progress UI (`cli-progress`+`ora`+`chalk`), exit codes | `server`, `client`, `config` |
| `index.ts` | library surface: `startServer`, `sendFiles`, types | all above |

No `tar` dependency: the chunked protocol removes the whole tar-slip class.

## CLI surface (v1-compatible)

```
encrypted-share serve -p 3000 -k <pw> -o ./received-files [-c cfg] [--overwrite]
encrypted-share send [path=. ] -t host:port -k <pw> [-c cfg]
```

Exit codes: 0 ok · 1 usage/config · 2 transfer failed.

## Test plan (ships in `tests/`)

- `crypto.test.ts`: round-trip, wrong-key/tamper/AAD rejection, KDF determinism +
  salt sensitivity, HKDF session keys against an independent vector.
- `protocol.test.ts`: hello and frame codecs, unexpected-type rejection,
  ES02 detection, `sanitizePath` rejects evil paths.
- `secure-channel.test.ts`: frame round trip over a socket, wire bytes against
  an independent WebCrypto vector, replay and wrong-direction rejection.
- `manifest.test.ts`: dir walk, single file, sha256 correctness, symlink skip,
  empty-dir capture.
- `store.test.ts`: contiguity enforcement, state save/load, verify-then-land,
  overwrite refusal, evil-path refusal.
- `e2e.test.ts` (real TCP on 127.0.0.1, ephemeral port): directory transfer
  byte-identical; single-file transfer; resume from seeded partial; wrong
  password fails; tampered chunk fails; RESULT mismatch fails; the server
  closes an idle connection; the client fails with `timeout` against a
  server that never answers the hello; a transfer succeeds when `prepare` or
  `verifyAndLand` outlasts `idleTimeoutMs`.
- `tamper.test.ts`: a TCP man-in-the-middle proxy between a real `sendFiles`
  and a real `startServer`. Names and hashes stay off the wire; tampered
  HEADER, RESUME, and RESULT frames, a forged cleartext RESULT, a dropped or
  reordered CHUNK, and a replayed session all fail; ES02 peers get a clear
  error; frames held back from an abandoned session and released after a
  newer transfer cannot revert the file.
