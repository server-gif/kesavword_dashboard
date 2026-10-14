// PHP syntax check ("php -l") run on the web server over the SSH exec channel — same idea as
// lib/lint.js, but the connection is passed in (a Worker opens one per request).
let phpBin; // undefined = not resolved yet this isolate, null = server has no runnable PHP
let noPhpSince = 0;
const RECHECK_MS = 10 * 60000;
let phpLabel = 'PHP';

const posix = {
  join: (...p) => p.join('/').replace(/\/+/g, '/'),
  dirname: (p) => { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); },
};

// Prefer the PHP version the site is set to (Cloudways keeps it in <app>/.php_version).
async function resolvePhp(c, rootDir, env) {
  if (phpBin) return phpBin;
  if (phpBin === null && Date.now() - noPhpSince < RECHECK_MS) return null;
  let version = (env.PHP_VERSION || '').trim();
  if (!version) {
    for (const dir of [rootDir, posix.dirname(rootDir)]) {
      try {
        version = (await c.get(posix.join(dir, '.php_version'))).toString('utf8').trim();
        if (version) break;
      } catch (err) {
        if (!/no such file|not found|failure|enoent/i.test(err.message)) return null;
      }
    }
  }
  const candidates = /^\d+(\.\d+)?$/.test(version) ? [`php${version}`, 'php'] : ['php'];
  for (const bin of candidates) {
    let result;
    try {
      result = await c.exec(`command -v ${bin} >/dev/null && ${bin} -r 'echo PHP_VERSION;'`);
    } catch (err) {
      console.error('PHP syntax check: could not reach the server:', err.message);
      return null;
    }
    if (result.code === 0 && result.stdout.trim()) {
      phpBin = bin;
      phpLabel = `PHP ${result.stdout.trim().split('.').slice(0, 2).join('.')}`;
      return phpBin;
    }
  }
  phpBin = null;
  noPhpSince = Date.now();
  return null;
}

const LINE_RE = /^(?:PHP )?(Parse error|Fatal error|Warning|Deprecated|Notice):\s+(.*?) in Standard input code on line (\d+)/;

// c = an open connection from sftp.js. Returns { available, checker, errors, warnings }.
export async function lintPhp(c, content, rootDir, env) {
  const bin = await resolvePhp(c, rootDir, env);
  if (!bin) return { available: false, checker: null, errors: [], warnings: [] };
  // php -l with no file name reads the code from stdin (same as the local server did over SSH)
  const { stderr, stdout } = await c.exec(
    `${bin} -d display_errors=stderr -d log_errors=0 -d error_reporting=-1 -l`,
    content
  );
  const seen = new Set();
  const errors = [];
  const warnings = [];
  for (const raw of `${stderr}\n${stdout}`.split('\n')) {
    const m = raw.trim().match(LINE_RE);
    if (!m) continue;
    const key = `${m[3]}|${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const item = { line: Number(m[3]), message: m[2] };
    (/error/i.test(m[1]) ? errors : warnings).push(item);
  }
  return { available: true, checker: phpLabel, errors, warnings };
}

export const isPhpPath = (p) => /\.(php\d?|phtml)$/i.test(p);
