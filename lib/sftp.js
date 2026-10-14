const SftpClient = require('ssh2-sftp-client');

const fs = require('fs');

// Sign in with a password (SFTP_PASS) or an SSH private key file (SFTP_KEY_FILE).
const { SFTP_HOST, SFTP_PORT = 22, SFTP_USER, SFTP_PASS, SFTP_KEY_FILE } = process.env;

let client = null;
let connecting = null;
let homeDir = '/';

function getClient() {
  if (client) return Promise.resolve(client);
  if (connecting) return connecting;
  const c = new SftpClient('dashboard');
  connecting = c
    .connect({
      host: SFTP_HOST,
      port: Number(SFTP_PORT),
      username: SFTP_USER,
      ...(SFTP_KEY_FILE ? { privateKey: fs.readFileSync(SFTP_KEY_FILE) } : { password: SFTP_PASS }),
      readyTimeout: 20000,
      keepaliveInterval: 15000,
    })
    .then(async () => {
      homeDir = await c.cwd();
      // ssh2-sftp-client adds a few temporary listeners per running operation; many parallel
      // stats (the overview checks dozens of files at once) would otherwise trip Node's warning.
      c.client.setMaxListeners(200);
      const drop = () => { if (client === c) client = null; };
      c.on('end', drop);
      c.on('close', drop);
      c.on('error', drop);
      client = c;
      console.log(`Connected to ${SFTP_USER}@${SFTP_HOST} (home: ${homeDir})`);
      return c;
    })
    .finally(() => { connecting = null; });
  return connecting;
}

function isConnectionError(err) {
  return /not connected|no sftp connection|econnreset|socket|channel|timed out|closed/i.test(
    `${err.code || ''} ${err.message || ''}`
  );
}

// "Not connected" means the request never left this computer, so repeating it is always safe.
const NEVER_SENT = /not connected|no sftp connection/i;

async function run(fn, retryAfterDrop) {
  try {
    return await fn(await getClient());
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    const old = client;
    client = null;
    if (old) old.end().catch(() => {});
    if (!retryAfterDrop && !NEVER_SENT.test(`${err.code || ''} ${err.message || ''}`)) {
      // The change may or may not have reached the server; repeating it blindly could do it twice
      // (or fail confusingly, e.g. a rename whose source is already gone). Let the person check.
      const e = new Error('The connection to the server dropped during this change. Refresh to see whether it went through, then try again if needed.');
      e.status = 503;
      throw e;
    }
    return fn(await getClient());
  }
}

// Reads (list, stat, get…): reconnect and retry once if the connection dropped.
const withSftp = (fn) => run(fn, true);
// Changes (put, rename, mkdir, delete, chmod…): retry only when the request was never sent.
const withSftpWrite = (fn) => run(fn, false);

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

// get() resolves to [] instead of a Buffer for empty files.
async function getBuffer(path) {
  const b = await withSftp((c) => c.get(path));
  return Buffer.isBuffer(b) ? b : Buffer.alloc(0);
}

// Writes a whole file and returns its new mtime (ms) in three round trips:
// open → write (all chunks) → fstat + close together. put() + stat() takes five,
// which is noticeable on a far-away server. Path must already be absolute and normalized.
function writeFileFast(path, buffer) {
  return withSftpWrite((c) => new Promise((resolve, reject) => {
    const sftp = c.sftp;
    sftp.open(path, 'w', (err, handle) => {
      if (err) return reject(err);
      const finish = (writeErr) => {
        let mtime = null;
        let pending = 2;
        let failure = writeErr || null;
        const settle = () => {
          if (--pending) return;
          if (failure) reject(failure);
          else resolve(mtime);
        };
        sftp.fstat(handle, (e, attrs) => { if (!e && attrs) mtime = attrs.mtime * 1000; settle(); });
        sftp.close(handle, (e) => { if (e && !failure) failure = e; settle(); });
      };
      if (!buffer.length) return finish(null);
      sftp.write(handle, buffer, 0, buffer.length, 0, finish);
    });
  }));
}

// Returns { exists, text } — text is null when the file is missing, a folder, too big or binary.
async function readTextIfSmall(path, maxBytes) {
  const st = await withSftp((c) => c.stat(path)).catch(() => null);
  if (!st) return { exists: false, text: null };
  if (st.isDirectory || st.size > maxBytes) return { exists: true, text: null };
  const buf = await getBuffer(path);
  return { exists: true, text: isBinary(buf) ? null : buf.toString('utf8') };
}

module.exports = {
  getClient,
  withSftp,
  withSftpWrite,
  isBinary,
  getBuffer,
  writeFileFast,
  readTextIfSmall,
  getHome: () => homeDir,
  info: { host: SFTP_HOST, user: SFTP_USER },
};
