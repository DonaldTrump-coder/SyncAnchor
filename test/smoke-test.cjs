// Smoke test for SyncAnchor core logic (no SSH connection needed).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sshconfig = require('F:/Projects/SyncAnchor/out/sshconfig.js');
const relative = require('F:/Projects/SyncAnchor/out/relative.js');
const engine = require('F:/Projects/SyncAnchor/out/syncEngine.js');
const remoteState = require('F:/Projects/SyncAnchor/out/remoteState.js');
const liveSsh = require('F:/Projects/SyncAnchor/out/liveSsh.js');
const gitignore = require('F:/Projects/SyncAnchor/out/gitignore.js');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}

console.log('== sshconfig ==');
const hosts = sshconfig.readSshConfig();
console.log('  hosts:', hosts.map((h) => `${h.user}@${h.host}:${h.port} (${h.source})`).join(', '));
// Ports change over time (user edits ~/.ssh/config); assert hosts exist with non-default ports.
ok(hosts.some((h) => h.host === '183.147.142.40' && h.port !== 22), 'parses 183.147.142.40 (non-default port)');
ok(hosts.some((h) => h.host === 'workspace.featurize.cn' && h.port !== 22), 'parses workspace.featurize.cn (non-default port)');

console.log('== relative (traversal guard) ==');
ok(relative.relativeToBase('D:/a', 'D:/a/src/x.py') === 'src/x.py', 'normal file under base');
ok(relative.relativeToBase('D:/a', 'D:/a/src') === 'src', 'folder under base');
ok(relative.relativeToBase('D:/a', 'D:/b/x.py') === undefined, 'outside base → undefined');
ok(relative.relativeToBase('D:/a', 'D:/a') === undefined, 'base itself → undefined');
ok(relative.joinRemote('/home/u/p', 'src/x.py') === '/home/u/p/src/x.py', 'joinRemote POSIX');
ok(relative.joinRemote('/home/u/p/', 'src/x.py') === '/home/u/p/src/x.py', 'joinRemote strips trailing slash');

console.log('== excludes ==');
ok(relative.matchesExclude('node_modules', 'src/node_modules') === true, 'dir name matches at segment');
ok(relative.matchesExclude('.git', '.git/config') === true, '.git dir');
ok(relative.matchesExclude('*.zip', 'data/v1.zip') === true, '*.zip file');
ok(relative.matchesExclude('node_modules', 'src/main.py') === false, 'no false positive');
ok(relative.matchesExclude('__pycache__', 'a/b/__pycache__/x.cpython-311.pyc') === true, '__pycache__ dir');

console.log('== expandSelection ==');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syncanchor-'));
const mk = (p) => fs.mkdirSync(path.join(tmp, p), { recursive: true });
const wf = (p, c) => fs.writeFileSync(path.join(tmp, p), c || 'x');
mk('src'); mk('utils'); mk('data'); mk('node_modules');
wf('src/a.py'); wf('src/b.py'); wf('utils/c.py'); wf('data/v1.zip'); wf('node_modules/x.js'); wf('file.txt');
const excludes = ['.git', 'node_modules', 'venv', '__pycache__', '.vs', '*.zip'];

let items = engine.expandSelection(tmp, '/remote/base', [path.join(tmp, 'src')], excludes);
ok(items.length === 2 && items.every((i) => i.relPath.startsWith('src/')), 'select folder → recursive files (2)');

items = engine.expandSelection(tmp, '/remote/base', [tmp], excludes);
const rels = items.map((i) => i.relPath).sort();
console.log('  files:', rels.join(', '));
ok(rels.length === 4, 'select base → 4 files (excluded node_modules + *.zip)');
ok(!rels.some((r) => r.includes('node_modules') || r.endsWith('.zip')), 'excludes applied');

items = engine.expandSelection(tmp, '/remote/base', [path.join(tmp, 'file.txt')], excludes);
ok(items.length === 1 && items[0].relPath === 'file.txt' && items[0].remotePath === '/remote/base/file.txt', 'single file + remotePath');

// outside-base file must be dropped
const outside = path.join(os.tmpdir(), 'outside-file.txt');
fs.writeFileSync(outside, 'x');
items = engine.expandSelection(tmp, '/remote/base', [outside], excludes);
ok(items.length === 0, 'outside base dropped by guard');

// dedupe: folder + one of its files selected together → the file appears once
items = engine.expandSelection(tmp, '/remote/base', [path.join(tmp, 'src'), path.join(tmp, 'src', 'a.py')], excludes);
ok(items.length === 2, 'folder+file selection yields 2 unique files');
ok(items.filter((i) => i.relPath === 'src/a.py').length === 1, 'folder+file selection dedupes');

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(outside, { force: true });

console.log('== remoteState (Remote-SSH history from state.vscdb) ==');
const db = remoteState.remoteSshDbPath();
const entries = remoteState.readRemoteSshHistory();
console.log('  db:', db);
console.log('  entries:', entries.map((e) => `${e.user ? e.user + '@' : ''}${e.host}:${e.port}${e.isCurrent ? ' (current)' : ''}`).join(', '));
if (fs.existsSync(db)) {
  ok(entries.some((e) => e.host === '183.147.142.40'), 'history includes 183.147.142.40');
  ok(entries.some((e) => e.host.includes('smartml.cn')), 'history includes smartml hosts');
  ok(entries.some((e) => e.isCurrent), 'current/last connection marked');
  const dec = remoteState.decodeHostEntry(
    '7b22686f73744e616d65223a22776f726b73706163652e666561747572697a652e636e202d70203431353038222c2275736572223a2273736820666561747572697a65227d',
  );
  ok(dec && dec.host === 'workspace.featurize.cn' && dec.port === 41508 && dec.user === 'featurize', 'hex entry decoded (host/port/user)');
} else {
  console.log('  (state.vscdb not found — skipping remoteState assertions)');
}

console.log('== liveSsh (live connection detection) ==');
const p1 = liveSsh.parseSshCommandLine(
  '"C:\\Windows\\System32\\OpenSSH\\ssh.exe"  -T -D 52482 -F "C:\\Users\\ASUS\\.ssh\\config" "183.147.142.40" sh',
);
ok(p1 && p1.host === '183.147.142.40', 'parses real live ssh cmdline (skips program path + -F/-D values)');
const p2 = liveSsh.parseSshCommandLine('ssh -p 42420 -l featurize workspace.featurize.cn');
ok(p2 && p2.host === 'workspace.featurize.cn' && p2.port === 42420 && p2.user === 'featurize', 'parses -p and -l options');
const p3 = liveSsh.parseSshCommandLine('ssh user@host.example.com');
ok(p3 && p3.host === 'host.example.com' && p3.user === 'user', 'parses user@host form');
// Chinese Host aliases (e.g. `Host 算力自由T4` in ~/.ssh/config) must survive
// the command-line parser byte-for-byte — mojibake here never matches config.
const p4 = liveSsh.parseSshCommandLine('ssh "算力自由T4"');
ok(p4 && p4.host === '算力自由T4', 'parses non-ASCII (Chinese) host alias verbatim');
const targets = liveSsh.scanLiveSsh();
console.log('  live targets:', JSON.stringify(targets));
if (process.platform === 'win32') {
  if (targets.length === 0) {
    // No live ssh process right now (the user closed the session) — the
    // scanner itself is exercised above; skip the hit assertion instead of
    // failing on ambient machine state.
    console.log('  (no live ssh process right now — skipping hit assertion)');
  } else {
    // Ambient-state assertion, guarded to not depend on WHICH server the
    // user happens to be connected to: the scan output must never contain
    // mojibake hosts (U+FFFD replacement chars) — the PowerShell GBK→UTF-8
    // decoding bug that made Chinese aliases unconnectable.
    const mojibake = targets.filter((t) => t.host.includes('\uFFFD'));
    ok(
      mojibake.length === 0,
      'no mojibake (U+FFFD) host in live scan — PowerShell UTF-8 output fix',
    );
  }
} else {
  console.log('  (non-Windows: scan is best-effort)');
}

console.log('== gitignore ==');
const gi = gitignore.parseGitignore('node_modules\n# comment\ndist/\n*.log\n!keep.log\n/src/gen\nbuild/\n');
ok(gi('node_modules/x.js', false), 'basename pattern matches at depth');
ok(!gi('src/app.js', false), 'non-matching file not ignored');
ok(gi('dist/bundle.js', true), 'dir-only pattern matches dirs');
ok(!gi('dist', false), 'dir-only pattern ignores files');
ok(gi('x.log', false), 'glob *.log matches');
ok(!gi('keep.log', false), 'negation ! re-includes');
ok(gi('src/gen/out.js', false), 'anchored pattern matches subtree under base');
ok(!gi('other/gen/out.js', false), 'anchored pattern does not match elsewhere');
ok(gi('a/b/node_modules/c.js', false), 'basename matches at any depth');
ok(gi('build/x/y.js', false), 'slash dir pattern anchored to base');

(async () => {
  // diffRemote distinguishes "remote file absent" (ENOENT → new) from real
  // failures (dead session → error), so a broken SSH connection is surfaced
  // during preview instead of silently mislabelling files as new.
  const mkItem = (p) => ({ relPath: p, localPath: 'x', remotePath: '/r/' + p, status: 'new', size: 1, mtimeMs: 1 });
  const sftpENOENT = { stat: (p, cb) => cb(Object.assign(new Error('no such file'), { code: 'ENOENT' })) };
  const sftpDead = { stat: (p, cb) => cb(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })) };
  const fresh = await engine.diffRemote(sftpENOENT, [mkItem('a.txt')]);
  ok(fresh[0].status === 'new', 'ENOENT stat → new');
  const broken = await engine.diffRemote(sftpDead, [mkItem('b.txt')]);
  ok(broken[0].status === 'error' && !!broken[0].error, 'non-ENOENT stat failure → error');

  // uploadFiles must pass the transfer pipeline (chunkSize × concurrency)
  // through to fastPut and register the per-file progress step callback —
  // the WAN speed fix is worthless if the settings get dropped.
  const fastPutCalls = [];
  const sftpUpload = {
    stat: (p, cb) => cb(Object.assign(new Error('no such file'), { code: 'ENOENT' })),
    mkdir: (p, cb) => cb(),
    fastPut: (local, remote, opts, cb) => {
      fastPutCalls.push({
        local,
        remote,
        chunkSize: opts.chunkSize,
        concurrency: opts.concurrency,
        hasStep: typeof opts.step === 'function',
      });
      if (typeof opts.step === 'function') {
        opts.step(1, 1, 1); // one progress tick
      }
      cb();
    },
  };
  const upItems = [mkItem('big/model.bin')];
  const fileProgress = [];
  await engine.uploadFiles(sftpUpload, upItems, {
    backup: false,
    chunkSize: 131072,
    concurrency: 256,
    onProgress: () => {},
    onFileProgress: (rel, done, total) => fileProgress.push([rel, done, total]),
  });
  ok(fastPutCalls.length === 1, 'uploadFiles calls fastPut once per file');
  ok(
    fastPutCalls[0].chunkSize === 131072 && fastPutCalls[0].concurrency === 256,
    'pipeline settings passed through to fastPut',
  );
  ok(fastPutCalls[0].hasStep, 'step callback registered (per-file progress)');
  ok(fileProgress.length === 1 && fileProgress[0][0] === 'big/model.bin', 'onFileProgress relayed');
  ok(upItems[0].status === 'done', 'uploaded item marked done');
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
