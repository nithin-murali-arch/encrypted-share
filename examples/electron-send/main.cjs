const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { sendFiles, startServer } = require('@nithin93/encrypted-share');
const { isIP } = require('node:net');
const { join, basename } = require('node:path');
const { pathToFileURL } = require('node:url');
const { mkdtemp, writeFile, readFile, rm, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');

const smoke = process.argv.includes('--smoke');
const pageURL = pathToFileURL(join(__dirname, 'index.html')).href;
let window;
let selectedPath = null;
let active = false;
let fixturePath;

function trusted(event) {
  if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pageURL) {
    throw new Error('Untrusted sender.');
  }
}

function config(value) {
  if (!value || typeof value !== 'object') throw new Error('Enter connection settings.');
  const { host, port, password } = value;
  if (typeof host !== 'string' || host.length > 253 || host !== host.trim() ||
      !(isIP(host) || /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host))) {
    throw new Error('Enter a hostname or IP address.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Enter a port from 1 to 65535.');
  if (typeof password !== 'string' || password.length === 0 || password.length > 1024) throw new Error('Enter a password of 1 to 1024 characters.');
  return { host, port, password };
}

ipcMain.handle('transfer:pick', async (event) => {
  trusted(event);
  if (active) throw new Error('A transfer is already active.');
  active = true;
  try {
    const result = smoke ? { canceled: false, filePaths: [fixturePath] } : await dialog.showOpenDialog(window, {
      title: 'Select a file to send', properties: ['openFile'],
    });
    if (!result.canceled) selectedPath = result.filePaths[0];
    return selectedPath ? basename(selectedPath) : null;
  } finally {
    active = false;
  }
});

ipcMain.handle('transfer:send', async (event, value) => {
  trusted(event);
  if (active) throw new Error('A transfer is already active.');
  const options = config(value);
  if (!selectedPath) throw new Error('Select a file first.');
  active = true;
  let progress = { sentBytes: 0, totalBytes: 0, state: 'sending' };
  const publish = (next) => {
    progress = next;
    if (!window.isDestroyed()) window.webContents.send('transfer:progress', next);
  };
  try {
    const file = await stat(selectedPath);
    if (!file.isFile()) throw new Error('Select a regular file.');
    publish({ sentBytes: 0, totalBytes: file.size, state: 'sending' });
    await sendFiles({ ...options, path: selectedPath, idleTimeoutMs: 15000,
      onProgress: (sentBytes, totalBytes) => publish({ sentBytes, totalBytes, state: 'sending' }),
    });
    publish({ ...progress, state: 'complete' });
  } catch (error) {
    publish({ ...progress, state: 'error', error: error.message });
    throw new Error(error.message);
  } finally {
    active = false;
  }
});

async function runSmoke() {
  const root = await mkdtemp(join(tmpdir(), 'encrypted-share-electron-'));
  let receiver;
  try {
    const contents = Buffer.from('Electron main process transfer smoke\n'.repeat(40000));
    fixturePath = join(root, 'fixture.txt');
    await writeFile(fixturePath, contents);
    receiver = await startServer({ port: 0, password: 'smoke-only-password', outDir: join(root, 'received') });
    await window.loadFile(join(__dirname, 'index.html'));
    const result = await window.webContents.executeJavaScript(`(async () => {
      const messages = [];
      const unsubscribe = window.transfer.onProgress((message) => messages.push(message));
      if (typeof require !== 'undefined' || typeof process !== 'undefined') throw new Error('Node leaked into renderer');
      if (typeof window.transfer.invoke !== 'undefined') throw new Error('Unrestricted IPC exposed');
      await window.transfer.pickFile();
      let invalidRejected = false;
      try { await window.transfer.send({host: '127.0.0.1', port: 0, password: 'x'}); }
      catch { invalidRejected = true; }
      let wrongPasswordRejected = false;
      try { await window.transfer.send({host: '127.0.0.1', port: ${receiver.port}, password: 'wrong-password'}); }
      catch { wrongPasswordRejected = true; }
      const sending = window.transfer.send({host: '127.0.0.1', port: ${receiver.port}, password: 'smoke-only-password'});
      let concurrentRejected = false;
      try { await window.transfer.send({host: '127.0.0.1', port: ${receiver.port}, password: 'smoke-only-password'}); }
      catch { concurrentRejected = true; }
      await sending;
      await new Promise((resolve) => setTimeout(resolve, 100));
      unsubscribe();
      return {messages, invalidRejected, concurrentRejected, wrongPasswordRejected};
    })()`);
    assert.equal(result.invalidRejected, true);
    assert.equal(result.concurrentRejected, true);
    assert.equal(result.wrongPasswordRejected, true);
    assert(result.messages.some((message) => message.state === 'error' && typeof message.error === 'string'));
    assert(result.messages.some((message) => message.state === 'sending'));
    assert.equal(result.messages.at(-1).state, 'complete');
    assert.equal(result.messages.at(-1).totalBytes, contents.length);
    assert.equal(result.messages.at(-1).sentBytes, contents.length);
    assert.deepEqual(await readFile(join(root, 'received', 'fixture.txt')), contents);
    console.log(`SMOKE PASS: ${contents.length} bytes received and compared; renderer isolation, validation, concurrency, error recovery, and progress checked.`);
  } finally {
    if (receiver) await receiver.close();
    await rm(root, { recursive: true, force: true });
  }
}

app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 620, height: 560, show: !smoke,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  if (smoke) {
    const timeout = setTimeout(() => { console.error('SMOKE FAIL: timed out'); app.exit(1); }, 30000);
    try { await runSmoke(); clearTimeout(timeout); app.exit(0); }
    catch (error) { console.error('SMOKE FAIL:', error); clearTimeout(timeout); app.exit(1); }
  } else {
    await window.loadFile(join(__dirname, 'index.html'));
  }
}).catch((error) => { console.error(error.message); app.exit(1); });
app.on('window-all-closed', () => app.quit());
