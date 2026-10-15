import { once } from 'events';
import { connect, createServer, Socket } from 'net';
import { SocketChannel } from '../src/channel';
import { SessionKeys } from '../src/crypto';
import { FrameType, TransferError } from '../src/protocol';
import { SecureChannel } from '../src/secure-channel';

jest.setTimeout(15000);

const keys: SessionKeys = {
  clientToServer: Buffer.alloc(32, 0x11),
  serverToClient: Buffer.alloc(32, 0x22),
};

const sockets: Socket[] = [];
afterEach(() => {
  while (sockets.length > 0) sockets.pop()!.destroy();
});

async function socketPair(): Promise<[Socket, Socket]> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const accepted = once(server, 'connection') as Promise<[Socket]>;
  const a = connect(port, '127.0.0.1');
  await once(a, 'connect');
  const [b] = await accepted;
  server.close();
  sockets.push(a, b);
  return [a, b];
}

async function rawBytes(sock: Socket, count: number): Promise<Buffer> {
  const ch = new SocketChannel(sock);
  return ch.readExact(count);
}

async function expectCode(pending: Promise<unknown>, code: string, message?: string): Promise<void> {
  try {
    await pending;
  } catch (err) {
    expect(err).toBeInstanceOf(TransferError);
    expect((err as TransferError).code).toBe(code);
    if (message !== undefined) expect((err as Error).message).toBe(message);
    return;
  }
  throw new Error(`expected TransferError ${code}`);
}

describe('SecureChannel', () => {
  test('round-trips the frame sequence in both directions', async () => {
    const [a, b] = await socketPair();
    const client = new SecureChannel(new SocketChannel(a), keys, 'client');
    const server = new SecureChannel(new SocketChannel(b), keys, 'server');

    await client.send(FrameType.HEADER, { chunkSize: 4, files: [{ path: 'x', size: 3, sha256: 'h' }], dirs: [] });
    expect(await server.recv([FrameType.HEADER])).toEqual({
      type: FrameType.HEADER,
      body: { chunkSize: 4, files: [{ path: 'x', size: 3, sha256: 'h' }], dirs: [] },
    });
    await server.send(FrameType.RESUME, { received: { x: 1 } });
    expect((await client.recv([FrameType.RESUME])).body).toEqual({ received: { x: 1 } });
    await client.send(FrameType.CHUNK, { fileIndex: 0, offset: 1n, data: Buffer.from('yz') });
    await client.send(FrameType.DONE, null);
    expect(await server.recv([FrameType.CHUNK, FrameType.DONE])).toEqual({
      type: FrameType.CHUNK,
      body: { fileIndex: 0, offset: 1n, data: Buffer.from('yz') },
    });
    expect(await server.recv([FrameType.CHUNK, FrameType.DONE])).toEqual({ type: FrameType.DONE, body: null });
  });

  test('sealed frame overhead is LEN(4) + TYPE(1) + tag(16)', async () => {
    const [a, b] = await socketPair();
    const client = new SecureChannel(new SocketChannel(a), keys, 'client');
    const reading = rawBytes(b, 21 + 133);
    await client.send(FrameType.DONE, null);
    await client.send(FrameType.CHUNK, { fileIndex: 0, offset: 0n, data: Buffer.alloc(100) });
    const wire = await reading;
    expect(wire.readUInt32BE(0)).toBe(17);
    expect(wire.readUInt32BE(21)).toBe(129);
  });

  test('wire bytes match an independent WebCrypto AES-GCM computation of the ES03 spec', async () => {
    const [a, b] = await socketPair();
    const client = new SecureChannel(new SocketChannel(a), keys, 'client');
    const reading = rawBytes(b, 42);
    await client.send(FrameType.DONE, null);
    await client.send(FrameType.DONE, null);
    expect((await reading).toString('hex')).toBe(
      '00000011c0deafe7ef29904eef23ead3b4358a1903' + '00000011cdbff2b0ab8614a7cc8b090c39cfa5ee87',
    );
  });

  test('recv rejects a frame type the sequence does not expect', async () => {
    const [a, b] = await socketPair();
    const client = new SecureChannel(new SocketChannel(a), keys, 'client');
    const server = new SecureChannel(new SocketChannel(b), keys, 'server');
    await client.send(FrameType.RESULT, { ok: true, verified: [], failed: [] });
    await expectCode(server.recv([FrameType.HEADER]), 'bad-frame', 'expected HEADER, got RESULT');
  });

  test('a frame replayed inside the session fails authentication', async () => {
    const [a, b] = await socketPair();
    const sender = new SecureChannel(new SocketChannel(a), keys, 'client');
    const captured = rawBytes(b, 21);
    await sender.send(FrameType.DONE, null);
    const frame = await captured;

    const [c, d] = await socketPair();
    const receiver = new SecureChannel(new SocketChannel(d), keys, 'server');
    c.write(Buffer.concat([frame, frame]));
    expect(await receiver.recv([FrameType.DONE])).toEqual({ type: FrameType.DONE, body: null });
    await expectCode(receiver.recv([FrameType.DONE]), 'decrypt-failed');
  });

  test('a frame sealed for the other direction fails authentication', async () => {
    const [a, b] = await socketPair();
    const client = new SecureChannel(new SocketChannel(a), keys, 'client');
    const alsoClient = new SecureChannel(new SocketChannel(b), keys, 'client');
    await client.send(FrameType.DONE, null);
    await expectCode(alsoClient.recv([FrameType.DONE]), 'decrypt-failed');
  });

  test('a frame shorter than a tag fails authentication', async () => {
    const [a, b] = await socketPair();
    const server = new SecureChannel(new SocketChannel(b), keys, 'server');
    a.write(Buffer.from('0000000300aabb', 'hex'));
    await expectCode(server.recv([FrameType.HEADER]), 'decrypt-failed');
  });
});
