import { sendFiles } from '@nithin93/encrypted-share';
const [path, port, password, stopAfter = '0', startOffset = '0'] = process.argv.slice(2);
const report = await sendFiles({ path, port: Number(port), host: '127.0.0.1', password,
  onProgress(sent, total) {
    if (sent === 0) console.log(`progress start offset=${startOffset}, total=${total}`);
    if (Number(stopAfter) > 0 && sent >= Number(stopAfter)) process.kill(process.pid, 'SIGKILL');
  },
});
process.send?.(report);
console.log(`attempt sent ${report.bytes} bytes`);
