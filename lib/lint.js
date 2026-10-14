// PHP syntax check ("php -l") run on the web server itself over SSH, so it uses the same PHP the site runs.
const path = require('path');
const { getClient, getBuffer } = require('./sftp');

const posix = path.posix;
const TIMEOUT_MS = 15000;

let phpBin; // undefined = not resolved yet, null = the server has no PHP we can run
let noPhpSince = 0;
const RECHECK_MS = 10 * 60000;
let phpLabel = 'PHP';

function exec(cmd, input) {
  return getClient().then((c) => new Promise((resolve, reject) => {
    c.client.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { stream.close(); reject(new Error('Check timed out')); }, TIMEOUT_MS);
      stream.on('data', (d) => { stdout += d; });
      stream.stderr.on('data', (d) => { stderr += d; });
      stream.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      stream.end(input ?? '');
    });
  }));
}

// Prefer the PHP version the website is set to (Cloudways keeps it in <app>/.php_version).
async function resolvePhp(rootDir) {
  if (phpBin) return phpBin;
  if (phpBin === null && Date.now() - noPhpSince < RECHECK_MS) return null;
  let version = (process.env.PHP_VERSION || '').trim();
  if (!version) {
    for (const dir of [rootDir, posix.dirname(rootDir)]) {
      try {
        version = (await getBuffer(posix.join(dir, '.php_version'))).toString('utf8').trim();
        if (version) break;
      } catch (err) {
        // A missing file is fine; anything else (connection trouble) means: try again later,
        // rather than settling on the wrong PHP version.
        if (!/no such file/i.test(err.message)) return null;
      }
    }
  }
  const candidates = /^\d+(\.\d+)?$/.test(version) ? [`php${version}`, 'php'] : ['php'];
  for (const bin of candidates) {
    let result;
    try {
      result = await exec(`command -v ${bin} >/dev/null && ${bin} -r 'echo PHP_VERSION;'`);
    } catch (err) {
      // Couldn't even ask (connection trouble): don't remember "no PHP" — try again next time.
      console.error('PHP syntax check: could not reach the server:', err.message);
      return null;
    }
    if (result.code === 0 && result.stdout.trim()) {
      phpBin = bin;
      phpLabel = `PHP ${result.stdout.trim().split('.').slice(0, 2).join('.')}`;
      console.log(`PHP syntax checks use ${bin} (${result.stdout.trim()})`);
      return phpBin;
    }
  }
  console.error('PHP syntax checks unavailable: no php binary on the server');
  phpBin = null;
  noPhpSince = Date.now();
  return phpBin;
}

const LINE_RE = /^(?:PHP )?(Parse error|Fatal error|Warning|Deprecated|Notice):\s+(.*?) in Standard input code on line (\d+)/;

// Returns { available, checker, errors: [{ line, message }], warnings: [...] }
async function lintPhp(content, rootDir) {
  const bin = await resolvePhp(rootDir);
  if (!bin) return { available: false, checker: null, errors: [], warnings: [] };
  const { stderr, stdout } = await exec(
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

const isPhpPath = (p) => /\.(php\d?|phtml)$/i.test(p);

module.exports = { lintPhp, isPhpPath };
