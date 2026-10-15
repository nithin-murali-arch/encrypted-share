import { startServer } from '@nithin93/encrypted-share';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function createWebhookNotifier({ webhookUrl, timeoutMs = 5000, logError = console.error }) {
  const url = new URL(webhookUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('WEBHOOK_URL must use HTTP or HTTPS');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new Error('WEBHOOK_TIMEOUT_MS must be an integer from 1 to 60000');
  }
  const pending = new Set();

  function onTransfer(message) {
    const completion = /^transfer complete: (\d+) file\(s\) verified$/.exec(message);
    if (!completion) return;
    const request = (async () => {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event: 'transfer.complete', verifiedFiles: Number(completion[1]), message }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch (error) {
        logError(`Webhook delivery failed: ${error.message}`);
      }
    })();
    pending.add(request);
    void request.finally(() => pending.delete(request));
  }

  return { onTransfer, flush: () => Promise.all(pending) };
}

export async function startReceiver({ password, outDir, port = 4000, webhookUrl, timeoutMs, logError }) {
  if (!password) throw new Error('Set ES_PASSWORD to the shared transfer password');
  if (!outDir) throw new Error('Set ES_OUT_DIR to the destination directory');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('ES_PORT must be an integer from 0 to 65535');
  const notifier = createWebhookNotifier({ webhookUrl, timeoutMs, logError });
  const server = await startServer({ password, outDir: resolve(outDir), port, idleTimeoutMs: 30000, onTransfer: notifier.onTransfer });
  let closing;
  return {
    port: server.port,
    close() {
      closing ??= (async () => {
        try {
          await server.close();
        } finally {
          await notifier.flush();
        }
      })();
      return closing;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const receiver = await startReceiver({
      password: process.env.ES_PASSWORD,
      outDir: process.env.ES_OUT_DIR,
      port: Number(process.env.ES_PORT ?? 4000),
      webhookUrl: process.env.WEBHOOK_URL,
      timeoutMs: Number(process.env.WEBHOOK_TIMEOUT_MS ?? 5000),
    });
    console.log(`Receiving encrypted transfers on port ${receiver.port}`);
    const shutdown = () => {
      void receiver.close().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
