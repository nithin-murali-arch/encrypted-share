import { once } from 'events';
import { createServer, connect, Server, Socket } from 'net';
import { SocketChannel } from '../src/channel';
import { TransferError } from '../src/protocol';

jest.setTimeout(15000);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Fixture {
  server: Server;
  peer: Socket;
  client: Socket;
  channel: SocketChannel;
  port: number;
}

async function makePausedPair(): Promise<Fixture> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const peerPromise = once(server, 'connection') as Promise<[Socket]>;
  const client = connect(port, '127.0.0.1');
  await once(client, 'connect');
  const [peer] = await peerPromise;
  peer.pause();
  return { server, peer, client, channel: new SocketChannel(client), port };
}

async function destroy(fx: Partial<Fixture>): Promise<void> {
  fx.client?.destroy();
  fx.peer?.destroy();
  if (fx.server) await new Promise<void>((resolve) => fx.server!.close(() => resolve()));
}

function fillSendBuffer(sock: Socket): void {
  const chunk = Buffer.alloc(256 * 1024);
  const target = 32 * 1024 * 1024;
  for (let i = 0; i < 500; i++) {
    sock.write(chunk);
    if (sock.writableLength >= target) return;
  }
  throw new Error('send buffer never filled');
}

describe('SocketChannel', () => {
  test('write waits for drain under backpressure, then resolves', async () => {
    const fx = await makePausedPair();
    try {
      fillSendBuffer(fx.client);
      let done = false;
      const pending = fx.channel.write(Buffer.alloc(1024)).then(() => {
        done = true;
      });
      await sleep(50);
      expect(done).toBe(false);
      fx.peer.resume();
      await pending;
      expect(done).toBe(true);
    } finally {
      await destroy(fx);
    }
  });

  test('pending write rejects when the socket errors', async () => {
    const fx = await makePausedPair();
    try {
      fillSendBuffer(fx.client);
      const pending = fx.channel.write(Buffer.alloc(1024));
      const assertion = expect(pending).rejects.toThrow('boom');
      fx.client.destroy(new Error('boom'));
      await assertion;
    } finally {
      await destroy(fx);
    }
  });

  test('pending write rejects when the socket is destroyed locally', async () => {
    const fx = await makePausedPair();
    try {
      fillSendBuffer(fx.client);
      const pending = fx.channel.write(Buffer.alloc(1024));
      const assertion = expect(pending).rejects.toThrow(TransferError);
      fx.client.destroy();
      await assertion;
    } finally {
      await destroy(fx);
    }
  });

  test('pending write settles promptly when the peer goes away', async () => {
    const fx = await makePausedPair();
    try {
      fillSendBuffer(fx.client);
      const pending = fx.channel.write(Buffer.alloc(1024));
      fx.peer.destroy();
      // Kernel-level race: queued bytes may flush (resolve) or the close may
      // land first (TransferError reject). Either is correct; hanging is not.
      const outcome = await Promise.race([
        pending.then(
          () => 'resolved' as const,
          (err: unknown) =>
            (err instanceof TransferError ? 'rejected-transfer' : 'rejected-raw') as const,
        ),
        sleep(5000).then(() => 'TIMEOUT' as const),
      ]);
      expect(['resolved', 'rejected-transfer']).toContain(outcome);
    } finally {
      await destroy(fx);
    }
  });

  test('pending read surfaces socket errors as transfer-failed', async () => {
    const fx = await makePausedPair();
    try {
      const pending = fx.channel.readExact(10);
      const assertion = (async (): Promise<void> => {
        try {
          await pending;
        } catch (err) {
          expect(err).toBeInstanceOf(TransferError);
          expect((err as TransferError).code).toBe('transfer-failed');
          return;
        }
        throw new Error('should have thrown');
      })();
      fx.client.destroy(new Error('boom'));
      await assertion;
    } finally {
      await destroy(fx);
    }
  });

  test('write after failure rejects immediately', async () => {
    const fx = await makePausedPair();
    try {
      fx.client.destroy(new Error('boom'));
      await sleep(20);
      await expect(fx.channel.write(Buffer.alloc(1))).rejects.toThrow(TransferError);
    } finally {
      await destroy(fx);
    }
  });
});
