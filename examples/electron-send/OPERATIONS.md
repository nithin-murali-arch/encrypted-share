# Send a file with Electron

Use Node.js 22.12 or newer and a graphical desktop. Install this example from the packed library before starting it. Run the commands in README.md in order. The tarball installs the published entry point, rather than importing source files. Repeat the tarball installation after `npm ci`, which removes packages installed with `--no-save`.

On the receiving computer, start the matching version of encrypted-share. From this example directory, run:

```sh
npx encrypted-share serve --port 3000 --key 'replace-this-password' --out ./received
```

Open the Electron app on the sending computer. Enter the receiver hostname or IP address, TCP port, and the same password. Click **Choose file**, select one regular file, and click **Send file**. Wait for **Transfer complete**. An error appears below the progress bar. Correct the settings and retry after a failure. Only one picker or transfer can run at a time.

The receiver listens on all network interfaces. Allow the chosen TCP port through the receiver firewall. The app keeps the password in memory for the current window. It does not save connection settings. Closing the window ends an active send. Retry the same file to use the library's resume support.

## Run the smoke check

After installing the tarball, run:

```sh
npx electron . --smoke
```

The command starts a real Electron window hidden from view, loads the renderer and preload, and starts a local receiver on an ephemeral port. It calls the preload's file picker and send methods using a generated fixture. Smoke mode supplies that fixture instead of opening a native file dialog. It checks renderer isolation, invalid port rejection, rejection of a concurrent send, wrong-password error recovery, progress, and the final bytes on disk. It removes the temporary files and exits with code 0 after `SMOKE PASS`. Failure or a 30-second deadline exits with code 1. A graphical Electron session is required, including for this smoke check. The check does not exercise a human's native file-dialog selection.

The main process owns the selected path and validates connection settings. The context-isolated renderer receives only a file name and progress objects shaped as `{ sentBytes, totalBytes, state, error? }`. States are `sending`, `complete`, and `error`. The preload exposes only `pickFile`, `send`, and `onProgress`. It does not expose Node.js or unrestricted IPC.
