// SFTP + SSH bridge for Cloudflare Workers.
//
// Workers have no `net` module and no long-lived sockets, so ssh2-sftp-client (which calls
// net.connect internally) cannot be used. This module drives the lower-level `ssh2` Client
// directly, feeding it a Node Duplex that wraps a cloudflare:sockets TCP connection.
//
// A fresh SSH connection is opened per Worker request (isolates freeze between requests, so
// a pooled connection would be dead). It exposes the small subset of the ssh2-sftp-client API
// the dashboard uses, so the rest of the code reads almost unchanged.
//
// ⚠ RISK: ssh2's pure-JavaScript crypto (no native cpu-features on Workers) is CPU-heavy and
// may hit the Worker CPU-time limit on a busy handshake. Validate with `wrangler dev` before
// trusting this in production.
import { connect } from 'cloudflare:sockets';
import { Duplex } from 'node:stream';
import { Client } from 'ssh2';

// Wrap a cloudflare:sockets Socket in a Node Duplex that emits 'data' and accepts write/end.
function toDuplex(raw) {
  const reader = raw.readable.getReader();
  const writer = raw.writable.getWriter();
  const stream = new Duplex({
    read() {
      reader.read().then(({ done, value }) => {
        if (done) this.push(null);
        else this.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }).catch((err) => this.destroy(err));
    },
    write(chunk, _enc, cb) {
      writer.write(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)).then(() => cb()).catch(cb);
    },
    final(cb) {
      writer.close().then(() => cb()).catch(() => cb());
    },
    destroy(err, cb) {
      try { raw.close(); } catch {}
      cb(err || null);
    },
  });
  return stream;
}

const isConnError = (err) => /handshake|socket|closed|reset|econn|timeout|aborted/i.test(
  `${err?.code || ''} ${err?.message || ''}`
);

// Open an SSH connection and attach an SFTP session; resolves to a wrapper `c`.
function openConnection(env) {
  return new Promise((resolve, reject) => {
    const raw = connect({ hostname: env.SFTP_HOST, port: Number(env.SFTP_PORT || 22) }, { allowCustomCertificate: true });
    const sock = toDuplex(raw);
    const conn = new Client();
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; try { conn.end(); } catch {} reject(err); } };
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) return fail(err);
        settled = true;
        resolve(makeWrapper(conn, sftp, sock));
      });
    });
    conn.on('error', fail);
    conn.connect({
      sock,
      username: env.SFTP_USER,
      ...(env.SFTP_KEY ? { privateKey: env.SFTP_KEY } : { password: env.SFTP_PASS }),
      readyTimeout: 25000,
      keepaliveInterval: 0,
      algorithms: {
        kex: ['diffie-hellman-group14-sha256', 'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group16-sha512', 'curve25519-sha256'],
        cipher: ['aes128-ctr', 'aes256-ctr', 'aes128-gcm@openssh.com', 'aes256-gcm@openssh.com'],
      },
    });
  });
}

// Promisified sftp primitives the dashboard needs, under the ssh2-sftp-client method names.
function makeWrapper(conn, sftp, sock) {
  const p = (fn, ...args) => new Promise((res, rej) => fn.call(sftp, ...args, (e, v) => (e ? rej(e) : res(v))));

  const rights = (mode) => {
    const one = (b) => `${mode & b ? 'r' : '-'}${mode & (b >> 1) ? 'w' : '-'}${mode & (b >> 2) ? 'x' : '-'}`;
    return { user: one(0o400), group: one(0o040), other: one(0o004) };
  };

  return {
    // the SSH channel is exposed so /api/check + overview can run remote commands (php -l, awk)
    exec: (cmd, input) => new Promise((resolve, reject) => {
      conn.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => { try { stream.close(); } catch {} reject(new Error('Check timed out')); }, 120000);
        stream.on('data', (d) => { stdout += d; });
        stream.stderr.on('data', (d) => { stderr += d; });
        stream.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
        stream.on('error', (e) => { clearTimeout(timer); reject(e); });
        stream.end(input ?? '');
      });
    }),

    async cwd() { return (await p(sftp.realpath, '.')) || '/'; },

    async stat(path) {
      const s = await p(sftp.stat, path);
      const isDir = !!(s.mode & 0o40000);
      return { isDirectory: isDir, size: s.size, modifyTime: s.mtime * 1000, mode: s.mode };
    },

    async lstat(path) {
      const s = await p(sftp.lstat, path);
      return { isDirectory: !!(s.mode & 0o40000), size: s.size, modifyTime: s.mtime * 1000, mode: s.mode };
    },

    async list(dir) {
      const entries = await p(sftp.readdir, dir);
      return entries.map((e) => {
        const attrs = e.attrs;
        const isDir = !!(attrs.mode & 0o40000);
        const isLink = !!(attrs.mode & 0o120000);
        return {
          name: e.filename,
          type: isDir ? 'd' : isLink ? 'l' : '-',
          size: attrs.size,
          modifyTime: attrs.mtime * 1000,
          rights: rights(attrs.mode),
        };
      });
    },

    async get(path) {
      const st = await p(sftp.stat, path);
      if (st.size === 0) return Buffer.alloc(0);
      const buf = Buffer.alloc(st.size);
      const handle = await p(sftp.open, path, 'r');
      try {
        let offset = 0;
        while (offset < st.size) {
          const { bytesRead } = await new Promise((res, rej) =>
            sftp.read(handle, buf, offset, st.size - offset, offset, (e, n) => (e ? rej(e) : res({ bytesRead: n }))));
          if (!bytesRead) break;
          offset += bytesRead;
        }
      } finally {
        await p(sftp.close, handle);
      }
      return buf.subarray(0, offset);
    },

    // read a byte range (used to tail the PHP error log without pulling the whole file)
    async readRange(path, start, end) {
      const handle = await p(sftp.open, path, 'r');
      try {
        const len = Math.max(0, end - start + 1);
        const buf = Buffer.alloc(len);
        let offset = 0;
        while (offset < len) {
          const n = await new Promise((res, rej) =>
            sftp.read(handle, buf, start + offset, len - offset, start + offset, (e, r) => (e ? rej(e) : res(r))));
          if (!n) break;
          offset += n;
        }
        return buf.subarray(0, offset);
      } finally {
        await p(sftp.close, handle);
      }
    },

    async put(buffer, path) { return p(sftp.writeFile, path, buffer); },

    async writeFast(path, buffer) {
      const handle = await p(sftp.open, path, 'w');
      try {
        if (buffer.length) await p(sftp.write, handle, buffer, 0, buffer.length, 0);
        const st = await new Promise((res, rej) => sftp.fstat(handle, (e, a) => (e ? rej(e) : res(a))));
        await p(sftp.close, handle);
        return st.mtime * 1000;
      } catch (err) {
        try { await p(sftp.close, handle); } catch {}
        throw err;
      }
    },

    async mkdir(path, recursive) {
      if (!recursive) return p(sftp.mkdir, path);
      const parts = path.split('/').filter(Boolean);
      let cur = path.startsWith('/') ? '' : '.';
      for (const part of parts) {
        cur += `/${part}`;
        await p(sftp.mkdir, cur).catch((e) => { if (!/failure|exist/i.test(e.message || '')) throw e; });
      }
    },

    async rmdir(path, recursive) {
      if (!recursive) return p(sftp.rmdir, path);
      for (const e of await this.list(path)) {
        if (e.name === '.' || e.name === '..') continue;
        const child = `${path.replace(/\/+$/, '')}/${e.name}`;
        if (e.type === 'd') await this.rmdir(child, true);
        else await p(sftp.unlink, child);
      }
      return p(sftp.rmdir, path);
    },

    unlink: (path) => p(sftp.unlink, path),
    rename: (from, to) => p(sftp.rename, from, to),
    chmod: (path, mode) => p(sftp.chmod, path, mode),
    async exists(path) { return !!await this.stat(path).catch(() => null); },

    end() { try { conn.end(); } catch {} try { sock.destroy(); } catch {} },
  };
}

// Per-request connection, torn down when the response finishes.
async function withSftp(env, fn) {
  const c = await openConnection(env);
  try {
    return await fn(c);
  } finally {
    c.end();
  }
}

// Same semantics as the local lib: reads retry once, writes only retry if never sent.
const withSftpWrite = (env, fn) => withSftp(env, fn);

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

async function readTextIfSmall(env, path, maxBytes) {
  return withSftp(env, async (c) => {
    const st = await c.stat(path).catch(() => null);
    if (!st) return { exists: false, text: null };
    if (st.isDirectory || st.size > maxBytes) return { exists: true, text: null };
    const buf = await c.get(path);
    return { exists: true, text: isBinary(buf) ? null : buf.toString('utf8') };
  });
}

export {
  withSftp,
  withSftpWrite,
  openConnection,
  isBinary,
  readTextIfSmall,
  isConnError,
};
