Install a local package tarball with `npm install --no-save --package-lock=false /absolute/path/to/nithin93-encrypted-share-3.0.1.tgz`, then run `ES_PASSWORD='your-shared-password' ES_OUT_DIR='./received' ES_PORT=4000 WEBHOOK_URL='http://127.0.0.1:8080/transfers' npm start` with Node.js 20 or later.

Create the tarball from the repository root with `npm pack --pack-destination /tmp`. Set `WEBHOOK_TIMEOUT_MS` to an integer from 1 to 60000 to change the default 5000 ms timeout. Use the same password in the sender. The receiver listens on all interfaces, as `startServer` does.

Each completion callback posts JSON such as `{"event":"transfer.complete","verifiedFiles":1,"message":"transfer complete: 1 file(s) verified"}`. Other callback messages do not post. Delivery failures print an error without retrying. A received transfer remains successful even if its webhook fails. This example has no durable queue or delivery guarantee. SIGINT and SIGTERM stop new transfers, wait for active connections to finish or reach their 30-second idle timeout, and drain pending webhook requests.

Run `npm run verify` after installing the tarball. The check uses a local HTTP collector and a real encrypted TCP transfer, checks received bytes and the completion JSON, rejects unrelated callback messages, and checks HTTP failure and timeout handling.
