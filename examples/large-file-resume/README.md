Run `npm install --no-save --package-lock=false /absolute/path/nithin93-encrypted-share-3.x.y.tgz && npm start` to interrupt a 2 GiB random file transfer, resume it over localhost TCP, and compare the files with `cmp`.

The 2 GiB check is currently blocked on a receiver backpressure fix. Released 3.0.1 buffers incoming TCP data while it writes files. A real 2 GiB run stalled and grew to about 5.5 GiB RSS. Do not run this default-size check against that version on a memory-constrained machine. A separate pause-on-data prototype passed the full interrupted/resumed `cmp` check, but that fix is not included in this example commit.

Node.js 20 or later and `cmp` are required. Keep at least 4.5 GiB free. Set `FILE_BYTES=33554432` for a shorter check or `KEEP_FILES=1` to inspect the output. The default creates 2 GiB, or 2,147,483,648 bytes.

The first sender terminates itself with `SIGKILL` after it has sent halfway. The receiver retains authenticated chunks. The second sender displays the receiver's persisted start offset. The public `onProgress` callback counts bytes sent during this attempt, so the script reads the example receiver's state to display the resumed position. It asserts that `SendReport.bytes` equals the total minus the saved offset. The state-file layout is internal and is used only by this local demonstration.

Resume skips bytes only when the source path, size, and SHA-256 still match. This is not incremental synchronization.
