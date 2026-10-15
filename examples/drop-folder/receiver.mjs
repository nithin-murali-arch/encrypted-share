import { startServer } from '@nithin93/encrypted-share';
const [outDir, password, port = '0'] = process.argv.slice(2);
const server = await startServer({ outDir, password, port: Number(port), onTransfer: message => process.send?.({ message }) });
process.send?.({ port: server.port });
