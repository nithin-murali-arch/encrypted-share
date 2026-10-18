const form = document.querySelector('#transfer-form');
const pick = document.querySelector('#pick');
const send = document.querySelector('#send');
const status = document.querySelector('#status');
const progress = document.querySelector('#progress');
let selected = false;
function busy(value) {
  for (const input of form.querySelectorAll('input, button')) input.disabled = value;
  send.disabled = value || !selected;
}
pick.addEventListener('click', async () => {
  busy(true);
  try {
    const name = await window.transfer.pickFile();
    selected = Boolean(name);
    document.querySelector('#filename').textContent = name || 'No file selected';
    status.textContent = name ? 'Ready to send.' : 'Choose a file to begin.';
  } catch (error) { status.textContent = error.message; }
  finally { busy(false); }
});
window.transfer.onProgress(({ sentBytes, totalBytes, state, error }) => {
  progress.max = totalBytes || 1;
  progress.value = sentBytes;
  status.textContent = state === 'error' ? error : state === 'complete'
    ? `Transfer complete. ${totalBytes} bytes verified by receiver.`
    : `Sending ${sentBytes} of ${totalBytes} bytes.`;
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  busy(true);
  progress.value = 0;
  status.textContent = 'Connecting to receiver...';
  try {
    await window.transfer.send({ host: document.querySelector('#host').value.trim(),
      port: Number(document.querySelector('#port').value), password: document.querySelector('#password').value });
  } catch (error) { status.textContent = error.message; }
  finally { busy(false); }
});
