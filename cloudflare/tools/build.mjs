// Pre-bundle the Worker with esbuild so the optional native `cpu-features` binary that ssh2
// tries to require is replaced by an empty stub (Workers cannot load .node files). Wrangler's
// [build] command runs this first; the Worker entry (wrangler main) is dist/worker.mjs.
import esbuild from 'esbuild';

const stubNative = {
  name: 'stub-native',
  setup(build) {
    // ssh2 does: try { require('cpu-features')() } catch {} — give it a no-op that reports no AES-NI
    build.onResolve({ filter: /cpu-features|cpufeatures\.node$/ }, () => ({ path: 'cpu-features-stub', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'module.exports = function () { return { hasAESNI: false, features: {}, detect() { return this; } }; };',
      loader: 'js',
    }));

    // ssh2 → asn1 → safer-buffer does `require('buffer')` then `buffer.hasOwnProperty(...)`, which
    // breaks under workerd's createRequire (returns an ESM namespace). Replace safer-buffer with a
    // shim that hands back the real Buffer directly.
    build.onResolve({ filter: /^safer-buffer$/ }, () => ({ path: 'safer-buffer', namespace: 'shim' }));
    build.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({
      contents: [
        'import { Buffer as B } from "node:buffer";',
        'class SlowBuffer extends B {}',
        'const mod = { Buffer: B, SlowBuffer, isBuffer: B.isBuffer.bind(B), kMaxLength: B.kMaxLength || 0x7fffffff, inspect: () => "", isEncoding: () => true };',
        'export default mod;',
        'export { B as Buffer, SlowBuffer };',
      ].join('\n'),
      loader: 'js',
    }));

    // ssh2 does `class SFTPStream extends require('stream')`. In real Node, require('stream') is a
    // callable constructor; under workerd the bare 'stream' specifier resolves to an ESM namespace
    // object (not a constructor), so `extends` throws. Re-export node:stream behind a callable class.
    build.onResolve({ filter: /^stream$/ }, () => ({ path: 'stream', namespace: 'stream-shim' }));
    build.onLoad({ filter: /.*/, namespace: 'stream-shim' }, () => ({
      contents: [
        'const s = require("node:stream");',
        'class LegacyStream extends s.Duplex {}',
        'Object.assign(LegacyStream, s);',
        'module.exports = LegacyStream;',
      ].join('\n'),
      loader: 'js',
    }));

    // ssh2 does `class X extends require('events')`. Same callable-vs-namespace problem as 'stream':
    // node:events required under workerd yields a namespace, so hand back the EventEmitter class.
    build.onResolve({ filter: /^events$/ }, () => ({ path: 'events', namespace: 'events-shim' }));
    build.onLoad({ filter: /.*/, namespace: 'events-shim' }, () => ({
      contents: [
        'const { EventEmitter } = require("node:events");',
        'EventEmitter.EventEmitter = EventEmitter;',
        'module.exports = EventEmitter;',
      ].join('\n'),
      loader: 'js',
    }));

    // ssh2 requires net/tls/dns/fs/os at module load (for agent forwarding + known_hosts we never
    // use). Workers cannot do a dynamic require of these, so resolve them to an inert stub. We
    // always pass our own cloudflare:sockets-backed `sock`, so none of these are actually called.
    build.onResolve({ filter: /^(net|tls|dns|fs|os|child_process|http|https)$/ }, (a) => ({ path: a.path, namespace: 'node-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'node-stub' }, (a) => {
      // http/https: ssh2/lib/http-agents.js pulls { Agent } at load (HTTP tunnel support we never use).
      if (a.path === 'http' || a.path === 'https') {
        return {
          contents: [
            'class Agent { constructor() {} destroy() {} }',
            'const noop = () => undefined;',
            'const mod = { Agent, globalAgent: new Agent(), request: noop, get: noop, Server: class {}, METHODS: [], statusCodes: {} };',
            'export default mod;',
            'export { Agent };',
            'export const globalAgent = mod.globalAgent, request = noop, get = noop;',
          ].join('\n'),
          loader: 'js',
        };
      }
      if (a.path === 'net' || a.path === 'tls') {
        return {
          contents: [
            'import { Duplex } from "node:stream";',
            'class Socket extends Duplex {}',
            'function connect() { throw new Error("direct TCP connect not supported here; pass a sock"); }',
            'export { Socket, connect };',
            'export const isIP = () => 0, isIPv4 = () => false, isIPv6 = () => false, lookup = () => {};',
            'export default { Socket, connect, isIP, isIPv4, isIPv6, lookup };',
          ].join('\n'),
          loader: 'js',
        };
      }
      // fs / os / dns: every property access returns a no-op function
      return {
        contents: [
          'const handler = { get: (t, p) => (p in t ? t[p] : () => undefined) };',
          'const stub = new Proxy({ homedir: () => "/", tmpdir: () => "/tmp" }, handler);',
          'export default stub;',
          'export const homedir = () => "/";',
          'export const tmpdir = () => "/tmp";',
        ].join('\n'),
        loader: 'js',
      };
    });
  },
};

await esbuild.build({
  entryPoints: ['src/index.js'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outfile: 'dist/worker.mjs',
  plugins: [stubNative],
  // cloudflare:sockets is provided by the Workers runtime; Node built-ins stay external on platform=node
  external: ['cloudflare:sockets'],
  // esbuild turns CJS require('stream') etc. into __require, which workerd rejects. Defining a
  // real `require` via createRequire makes esbuild's __require delegate to it (the canonical fix).
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(typeof import.meta.url === 'string' ? import.meta.url : 'file:///worker.js'); const __filename = (typeof import.meta.url === 'string' ? import.meta.url.replace('file://','') : '/worker.js'); const __dirname = __filename.slice(0, __filename.lastIndexOf('/')) || '/';",
  },
  define: {
    'process.version': '"v22.0.0"',
    'process.versions.node': '"22.0.0"',
  },
  logLevel: 'info',
});
