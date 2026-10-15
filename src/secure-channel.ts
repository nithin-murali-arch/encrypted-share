import { SocketChannel } from './channel';
import { openChunk, sealChunk, SessionKeys } from './crypto';
import {
  decodeFrame,
  encodeFrame,
  Frame,
  FRAME_AAD,
  FrameBodies,
  FrameType,
  MAX_MESSAGE_BYTES,
  NONCE_LENGTH,
  TAG_LENGTH,
  TransferError,
} from './protocol';

export type Role = 'client' | 'server';

function counterNonce(counter: bigint): Buffer {
  const nonce = Buffer.alloc(NONCE_LENGTH);
  nonce.writeBigUInt64BE(counter, NONCE_LENGTH - 8);
  return nonce;
}

function authFailure(): TransferError {
  return new TransferError(
    'decrypt-failed',
    'frame authentication failed: wrong password, or the frame was altered, dropped, reordered or replayed',
  );
}

export class SecureChannel {
  private readonly sendKey: Buffer;
  private readonly recvKey: Buffer;
  private sendCounter = 0n;
  private recvCounter = 0n;

  constructor(
    private readonly channel: SocketChannel,
    keys: SessionKeys,
    role: Role,
  ) {
    this.sendKey = role === 'client' ? keys.clientToServer : keys.serverToClient;
    this.recvKey = role === 'client' ? keys.serverToClient : keys.clientToServer;
  }

  async send<T extends FrameType>(type: T, body: FrameBodies[T]): Promise<void> {
    const nonce = counterNonce(this.sendCounter);
    this.sendCounter += 1n;
    const { ciphertext, tag } = sealChunk(this.sendKey, nonce, encodeFrame(type, body), FRAME_AAD);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(ciphertext.length + TAG_LENGTH, 0);
    await this.channel.write(Buffer.concat([len, ciphertext, tag]));
  }

  async recv<T extends FrameType>(
    expected: readonly T[],
    maxBytes: number = MAX_MESSAGE_BYTES,
  ): Promise<Frame<T>> {
    const sealed = await this.channel.readFrame(maxBytes);
    const nonce = counterNonce(this.recvCounter);
    this.recvCounter += 1n;
    if (sealed.length <= TAG_LENGTH) throw authFailure();
    let plaintext: Buffer;
    try {
      plaintext = openChunk(
        this.recvKey,
        nonce,
        sealed.subarray(0, sealed.length - TAG_LENGTH),
        sealed.subarray(sealed.length - TAG_LENGTH),
        FRAME_AAD,
      );
    } catch {
      throw authFailure();
    }
    return decodeFrame(plaintext, expected);
  }
}
