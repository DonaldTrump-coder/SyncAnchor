// Webview frontend smoke test: run media/panel.js in jsdom, drive it with
// messages, and assert the connection dropdown renders.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}

let html = fs.readFileSync(path.join(ROOT, 'media', 'panel.html'), 'utf8');
html = html.replace('{{CSP}}', '');
html = html.replace(/{{MEDIA}}/g, '.');
const script = fs.readFileSync(path.join(ROOT, 'media', 'panel.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'media', 'panel.css'), 'utf8');

// Regression guard: elements that toggle via the [hidden] attribute must NOT
// have a plain `display: flex` rule (it overrides hidden and makes ghost
// layers that cover the toolbar). They must default to none and show via
// `:not([hidden])`.
for (const cls of ['picker', 'progress']) {
  const block = css.match(new RegExp('\\.' + cls + '\\s*\\{[^}]*\\}'))?.[0] || '';
  ok(!/display\s*:\s*flex/.test(block), cls + ' base rule does not force display:flex');
  ok(css.includes('.' + cls + ':not([hidden])'), cls + ' has :not([hidden]) show rule');
}

// Scroll fix guard: grid columns must be allowed to shrink so their inner
// scroll containers actually scroll instead of overflowing the viewport.
for (const cls of ['grid', 'col', 'tree', 'log']) {
  const block = css.match(new RegExp('\\.' + cls + '\\s*\\{[^}]*\\}'))?.[0] || '';
  ok(/min-height\s*:\s*0/.test(block), cls + ' allows shrinking (min-height: 0)');
}

const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://webview/' });
const { window } = dom;
const sent = [];
window.acquireVsCodeApi = () => ({ postMessage: (m) => sent.push(m) });
const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
// jsdom lacks the pointer-capture API. The webview's drag-box captures the
// pointer so pointerup still arrives when the pointer leaves the webview; stub
// capture (statefully) so the code runs and the capture-request can be
// asserted below.
const captured = new Set();
window.Element.prototype.setPointerCapture = function (id) { captured.add(id); };
window.Element.prototype.hasPointerCapture = function (id) { return captured.has(id); };
window.Element.prototype.releasePointerCapture = function (id) { captured.delete(id); };
window.eval(script);

ok(sent.some((m) => m.type === 'ready'), 'panel posts ready on init');
ok(sent.some((m) => m.type === 'getConnections'), 'panel requests connections on init');

// Simulate a connections response: live + config + recent candidates.
const list = [
  { id: '183.147.142.40:31592', label: 'root@183.147.142.40', host: '183.147.142.40', port: 31592, user: 'root', source: 'remote', current: true },
  { id: 'workspace.featurize.cn:42420', label: 'featurize@workspace.featurize.cn', host: 'workspace.featurize.cn', port: 42420, user: 'featurize', source: 'config' },
  { id: 'instance-thgkviy1.hz.smartml.cn:22', label: 'root@instance-thgkviy1.hz.smartml.cn', host: 'instance-thgkviy1.hz.smartml.cn', port: 22, user: 'root', source: 'recent' },
  { id: 'instance-6p95yszn.hz.smartml.cn:22', label: 'root@instance-6p95yszn.hz.smartml.cn', host: 'instance-6p95yszn.hz.smartml.cn', port: 22, user: 'root', source: 'recent' },
  { id: 'proxy-ai.onethingai.com:22', label: 'root@proxy-ai.onethingai.com', host: 'proxy-ai.onethingai.com', port: 22, user: 'root', source: 'recent' },
];
window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'connections', list, activeId: undefined } }));

const select = window.document.getElementById('conn-select');
ok(select.options.length === 5, 'connSelect renders ' + select.options.length + ' options (expected 5)');
ok(select.options[0].value === '183.147.142.40:31592', 'first option is the live/current host');
ok(select.options[0].textContent.includes('current'), 'current host is labeled');
ok(select.selectedIndex === 0, 'first option auto-selected (Connect enabled)');
const connectBtn = window.document.getElementById('btn-connect');
ok(!connectBtn.disabled, 'Connect button enabled after render');

// State message applies bases.
window.dispatchEvent(new window.MessageEvent('message', {
  data: { type: 'state', localBase: 'D:/projects/x', remoteBase: '/root/x', connId: undefined, connLabel: undefined, connected: false, backup: false, excludes: ['.git'] },
}));
ok(window.document.getElementById('local-base').value === 'D:/projects/x', 'state applied to local base input');

// Log area has entries (ready + loaded).
const log = window.document.getElementById('log');
ok(log.childElementCount >= 2, 'log has entries (' + log.childElementCount + ')');
ok(log.textContent.includes('Connection list loaded: 5'), 'log reports candidate count');

ok(errors.length === 0, 'no JS errors' + (errors.length ? ': ' + errors.join(' | ') : ''));

// Empty list → placeholder option + disabled Connect.
window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'connections', list: [], activeId: undefined } }));
ok(select.options.length === 1 && select.options[0].value === '', 'empty list renders placeholder option');
ok(connectBtn.disabled, 'Connect disabled when no live connection');

// Remote base picker: connected without base → browse from home; ▾ opens the
// dropdown, clicking a dir navigates in, Select posts setRemoteBase.
window.dispatchEvent(new window.MessageEvent('message', {
  data: { type: 'state', localBase: 'D:/x', remoteBase: undefined, connId: 'x', connLabel: 'x', connected: true, backup: false, excludes: [] },
}));
window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'homeDir', path: '/root' } }));
ok(sent.some((m) => m.type === 'readRemoteDir' && m.dirPath === '/root'), 'browses home dir after connect without base');

const pickerBtn = window.document.getElementById('btn-remote-picker');
const pickerOkBtn = window.document.getElementById('picker-ok');
pickerBtn.click();
ok(sent.some((m) => m.type === 'readRemoteDir' && m.dirPath === '/root'), 'picker opens and reads current path');
window.dispatchEvent(new window.MessageEvent('message', {
  data: { type: 'remoteDir', dirPath: '/root', entries: [{ name: 'data', isDir: true }, { name: 'models', isDir: true }, { name: 'x.txt', isDir: false }] },
}));
const dirRows = window.document.querySelectorAll('.picker-dir');
ok(dirRows.length === 2, 'picker lists directories only (' + dirRows.length + ')');
dirRows[0].click();
ok(!window.document.getElementById('remote-picker').hidden, 'picker STAYS OPEN after navigating into a dir (stopPropagation)');
ok(sent.some((m) => m.type === 'readRemoteDir' && m.dirPath === '/root/data'), 'clicking a dir navigates into it');
window.dispatchEvent(new window.MessageEvent('message', {
  data: { type: 'remoteDir', dirPath: '/root/data', entries: [{ name: 'ISRA', isDir: true }] },
}));
ok(window.document.getElementById('picker-path').textContent === '/root/data', 'picker path shown');
ok(window.document.querySelectorAll('.crumb').length === 3, 'breadcrumb has 3 segments (/ root data)');
// Click the 'root' crumb (go up one level) — picker must stay open.
window.document.querySelectorAll('.crumb')[1].click();
ok(sent.some((m) => m.type === 'readRemoteDir' && m.dirPath === '/root'), 'crumb navigates up one level');
ok(!window.document.getElementById('remote-picker').hidden, 'picker STAYS OPEN after crumb navigation');
pickerOkBtn.click();
ok(sent.some((m) => m.type === 'setRemoteBase' && m.path === '/root'), 'Select posts setRemoteBase with navigated path');
ok(window.document.getElementById('remote-picker').hidden, 'picker closes after select');

// Remote reference tree: root resets when the base changes; expand shows an
// instant loading placeholder while the SFTP listing is in flight.
window.dispatchEvent(new window.MessageEvent('message', {
  data: { type: 'state', localBase: 'D:/x', remoteBase: '/root/data', connId: 'x', connLabel: 'x', connected: true, backup: false, excludes: [] },
}));
const treeRootName = window.document.querySelector('#remote-tree .node.dir > .row .dir-name');
ok(treeRootName && treeRootName.textContent === '/root/data', 'remote tree root resets to new base');
ok(sent.some((m) => m.type === 'readRemoteDir' && m.dirPath === '/root/data'), 'reads new base dir after base change');
window.dispatchEvent(new window.MessageEvent('message', {
  data: { type: 'remoteDir', dirPath: '/root/data', entries: [{ name: 'ISRA', isDir: true }] },
}));
const treeRows = window.document.querySelectorAll('#remote-tree .node.dir .row');
let israRow = null;
treeRows.forEach((r) => {
  if (r.textContent.includes('ISRA')) {
    israRow = r;
  }
});
ok(!!israRow, 'tree shows ISRA dir under new base');
israRow.click();
ok(sent.some((m) => m.type === 'readRemoteDir' && m.dirPath === '/root/data/ISRA'), 'tree expand requests listing');
const israChildren = israRow.parentElement.querySelector('.children');
ok(israChildren && israChildren.textContent.includes('loading'), 'expand shows loading placeholder instantly');

// Log clear button.
const logEl2 = window.document.getElementById('log');
logEl2.innerHTML = '';
window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'log', line: 'hello' } }));
ok(logEl2.childElementCount === 1, 'log appends message');
window.document.getElementById('btn-log-clear').click();
ok(logEl2.childElementCount === 1 && logEl2.textContent.includes('Log cleared'), 'log clear button works');

// Excluded entries are visible but greyed out with a disabled checkbox.
window.dispatchEvent(new window.MessageEvent('message', {
  data: { type: 'state', localBase: 'D:/proj', remoteBase: undefined, connId: 'x', connLabel: 'x', connected: false, backup: false, excludes: [] },
}));
window.dispatchEvent(new window.MessageEvent('message', {
  data: { type: 'dir', dirPath: 'D:/proj', entries: [
    { name: 'src', path: 'D:/proj/src', isDir: true, excluded: false },
    { name: 'node_modules', path: 'D:/proj/node_modules', isDir: true, excluded: true },
    { name: 'package.json', path: 'D:/proj/package.json', isDir: false, excluded: false },
  ] },
}));
const excludedNode = window.document.querySelector('#local-tree .node.excluded');
ok(!!excludedNode, 'excluded entry is visible in local tree');
ok(excludedNode.textContent.includes('excluded'), 'excluded entry shows badge');
ok(excludedNode.querySelector('input.chk').disabled, 'excluded entry checkbox is disabled');

// Refresh clears the transfer queue AND the stale selection.
const preChk = window.document.querySelectorAll('#local-tree input.chk')[0];
preChk.checked = true;
preChk.dispatchEvent(new window.Event('change'));
window.dispatchEvent(new window.MessageEvent('message', {
  data: { type: 'queue', items: [{ relPath: 'a.py', status: 'done', size: 1, mtimeMs: 1, localPath: 'x', remotePath: 'y' }], mode: 'result' },
}));
ok(window.document.querySelectorAll('#queue-list .qitem').length === 1, 'queue shows item after upload');
window.document.getElementById('btn-refresh').click();
ok(window.document.querySelectorAll('#queue-list .qitem').length === 0, 'refresh clears the transfer queue');
ok(window.document.querySelectorAll('#local-tree input.chk:checked').length === 0, 'refresh clears the stale selection');

// uploadDone without errors clears the selection; with errors it is kept.
preChk.checked = true;
preChk.dispatchEvent(new window.Event('change'));
window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'uploadDone', hasErrors: false } }));
ok(window.document.querySelectorAll('#local-tree input.chk:checked').length === 0, 'uploadDone (no errors) clears selection');
preChk.checked = true;
preChk.dispatchEvent(new window.Event('change'));
window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'uploadDone', hasErrors: true } }));
ok(window.document.querySelectorAll('#local-tree input.chk:checked').length === 1, 'uploadDone (with errors) keeps selection');
preChk.checked = false;
preChk.dispatchEvent(new window.Event('change'));

// Tree expand/collapse: clicking the twisty toggles exactly once (guarding the
// double-toggle bug), and clicking the row label blank area also expands.
const srcNode = [...window.document.querySelectorAll('#local-tree .node')].find(
  (n) => n.querySelector('.name')?.textContent === 'src',
);
const srcTwisty = srcNode.querySelector('.twisty');
const srcChildren = srcNode.querySelector('.children');
srcChildren.style.display = 'none'; // force collapsed so the assertion is real
srcTwisty.click();
ok(srcChildren.style.display !== 'none', 'twisty click expands (single toggle, not expand+collapse)');
ok(
  sent.filter((m) => m.type === 'readDir' && m.dirPath === 'D:/proj/src').length === 1,
  'twisty click requests dir exactly once',
);
srcTwisty.click();
ok(srcChildren.style.display === 'none', 'second twisty click collapses');
srcNode.querySelector('.chk-row').click();
ok(srcChildren.style.display !== 'none', 'row label blank area click expands');
ok(
  sent.filter((m) => m.type === 'readDir' && m.dirPath === 'D:/proj/src').length === 2,
  're-expanding a loaded folder refreshes (2nd request)',
);
// The jsdom label click forwards to the checkbox; undo it for later tests.
const srcChk = srcNode.querySelector('input.chk');
srcChk.checked = false;
srcChk.dispatchEvent(new window.Event('change'));

// Drag-box selection: mock node rects, then simulate mousedown/mousemove/mouseup.
const localTreeEl = window.document.getElementById('local-tree');
// The coordinate-based start check needs the tree's own bounding rect.
localTreeEl.getBoundingClientRect = () => ({ left: 0, top: 0, right: 200, bottom: 200 });
const localNodes = localTreeEl.querySelectorAll('.node');
const nodeRects = [
  { left: 0, top: 0, right: 200, bottom: 20 },
  { left: 0, top: 20, right: 200, bottom: 40 },
  { left: 0, top: 40, right: 200, bottom: 60 },
];
localNodes.forEach((n, i) => {
  n.getBoundingClientRect = () => nodeRects[Math.min(i, nodeRects.length - 1)];
});
const fire = (target, type, x, y) =>
  target.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, pointerId: 1 }));
fire(localTreeEl, 'pointerdown', 5, 5);
fire(window, 'pointermove', 150, 55);
fire(window, 'pointerup', 150, 55);
const checkedCount = localTreeEl.querySelectorAll('input.chk:checked').length;
ok(checkedCount === 2, 'drag-box selects intersecting nodes (' + checkedCount + ' of 3, excluded skipped)');

// Drag-box TOGGLES boxed nodes: pre-check package.json (outside the box), then
// box-select src only — src becomes checked, package.json outside stays checked.
const allChks = localTreeEl.querySelectorAll('input.chk');
for (const c of allChks) {
  c.checked = false;
}
const pkChk = allChks[2]; // package.json
pkChk.checked = true;
pkChk.dispatchEvent(new window.Event('change'));
ok(localTreeEl.querySelectorAll('input.chk:checked').length === 1, 'one node pre-selected before box-select');
fire(localTreeEl, 'pointerdown', 5, 25);
fire(window, 'pointermove', 150, 35); // covers only src (rect {0,20,200,40})
fire(window, 'pointerup', 150, 35);
const afterChk = localTreeEl.querySelectorAll('input.chk:checked');
ok(
  afterChk.length === 2 && afterChk[0] === allChks[0] && afterChk[1] === allChks[2],
  'box-select toggles boxed nodes; outside selection preserved',
);

// Box-select the same region again — boxed nodes toggle BACK off, outside
// selection (package.json) still untouched.
fire(localTreeEl, 'pointerdown', 5, 25);
fire(window, 'pointermove', 150, 35);
fire(window, 'pointerup', 150, 35);
const afterChk2 = localTreeEl.querySelectorAll('input.chk:checked');
ok(afterChk2.length === 1 && afterChk2[0] === allChks[2], 'second box-select toggles src back off');

// Dragging from the blank strip LEFT of the tree (tree starts at x=20) still
// starts a box-select — coordinate-based start check, not element containment.
localTreeEl.getBoundingClientRect = () => ({ left: 20, top: 0, right: 220, bottom: 200 });
fire(window.document.body, 'pointerdown', 5, 25); // x=5 is left of the tree
fire(window, 'pointermove', 150, 55);
fire(window, 'pointerup', 150, 55);
const leftChk = localTreeEl.querySelectorAll('input.chk:checked');
ok(leftChk.length >= 1, 'drag from the left gutter starts box-select (' + leftChk.length + ' checked)');

// Regression (real bug): a TALL tree — drag the box all the way past the
// bottom of the tree (and the webview). The pointer is captured on pointerdown,
// so a release past the panel edge must still toggle the boxed rows and the
// selection rect must NOT stick on screen. Rows: root (no checkbox), src,
// node_modules (excluded, disabled), package.json. Entering this block src is
// checked, package.json is not.
localTreeEl.getBoundingClientRect = () => ({ left: 0, top: 0, right: 200, bottom: 200 });
const tallNodes = [...localTreeEl.querySelectorAll('.node')];
const tallSrc = tallNodes[1].querySelector(':scope > .row input.chk');
const tallPkg = tallNodes[3].querySelector(':scope > .row input.chk');
fire(localTreeEl, 'pointerdown', 5, 5);
ok(window.document.body.hasPointerCapture(1), 'pointerdown requests pointer capture (release outside the webview still lands)');
fire(window, 'pointermove', 150, 500); // far below the tree bottom / panel edge
ok(!!window.document.querySelector('.sel-rect'), 'selection rect visible while dragging past the bottom edge');
fire(window, 'pointerup', 150, 500);
ok(
  tallSrc.checked === false && tallPkg.checked === true,
  'release past the tree bottom still toggles every boxed row',
);
ok(!window.document.querySelector('.sel-rect'), 'selection rect removed after release outside the tree');
ok(!window.document.body.hasPointerCapture(1), 'pointer capture released on pointerup');
// Consume the click-suppression guard like a real browser would.
window.document.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
// A second box over the same region toggles back (net zero) — the fix must
// keep working for repeated drags, not just the first one.
fire(localTreeEl, 'pointerdown', 5, 5);
fire(window, 'pointermove', 150, 500);
fire(window, 'pointerup', 150, 500);
ok(tallSrc.checked === true && tallPkg.checked === false, 'second tall drag toggles back (net zero)');
window.document.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

// pointercancel mid-drag (browser steals the pointer): the rect must not
// stick, nothing toggles, and the NEXT drag starts clean. The cancel targets
// the captured element (document.body) exactly as in a real browser.
fire(localTreeEl, 'pointerdown', 5, 5);
fire(window, 'pointermove', 150, 35);
ok(!!window.document.querySelector('.sel-rect'), 'drag in progress shows selection rect');
fire(window.document.body, 'pointercancel', 150, 35);
ok(!window.document.querySelector('.sel-rect'), 'pointercancel removes the selection rect');
ok(tallSrc.checked === true, 'pointercancel toggles nothing');
fire(localTreeEl, 'pointerdown', 5, 25);
fire(window, 'pointermove', 150, 35);
fire(window, 'pointerup', 150, 35);
ok(tallSrc.checked === false, 'box-select works again after pointercancel (toggled src off)');
ok(!window.document.querySelector('.sel-rect'), 'selection rect removed on the post-cancel drag');
// Consume the click-suppression guard from the last drag.
window.document.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

// A real browser fires a click after mouseup; jsdom does not. Emit it so the
// click-suppression guard is consumed exactly like in production.
window.document.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

// Folder <-> contents consistency.
// 1) checking a folder requests collectFiles and applies its files; unchecking
//    drops them again (verified through the Preview message payload).
window.dispatchEvent(new window.MessageEvent('message', {
  data: { type: 'state', localBase: 'D:/proj', remoteBase: '/root/data', connId: 'x', connLabel: 'x', connected: true, backup: false, excludes: [] },
}));
const srcNode2 = [...localTreeEl.querySelectorAll('.node')].find(
  (n) => n.querySelector('.name')?.textContent === 'src',
);
const srcChkBox = srcNode2.querySelector(':scope > .row input.chk');
srcChkBox.checked = true;
srcChkBox.dispatchEvent(new window.Event('change'));
ok(sent.some((m) => m.type === 'collectFiles' && m.dirPath === 'D:/proj/src'), 'folder check requests collectFiles');
window.dispatchEvent(new window.MessageEvent('message', {
  data: { type: 'filesCollected', dirPath: 'D:/proj/src', files: ['D:/proj/src/a.py', 'D:/proj/src/b.py'], dirs: [] },
}));
window.document.getElementById('btn-preview').click();
let previewMsg = sent.filter((m) => m.type === 'preview').pop();
ok(!!previewMsg && previewMsg.selectedPaths.includes('D:/proj/src/a.py'), 'folder check selects its files');
srcChkBox.checked = false;
srcChkBox.dispatchEvent(new window.Event('change')); // uncheck
window.dispatchEvent(new window.MessageEvent('message', {
  data: { type: 'filesCollected', dirPath: 'D:/proj/src', files: ['D:/proj/src/a.py', 'D:/proj/src/b.py'], dirs: [] },
}));
const previewCountBefore = sent.filter((m) => m.type === 'preview').length;
window.document.getElementById('btn-preview').click();
ok(
  sent.filter((m) => m.type === 'preview').length === previewCountBefore,
  'folder uncheck drops its files (preview blocked, nothing selected)',
);

// 3) Regression: checking a folder whose subtree is NOT yet rendered must
//    still select the subfolders inside it. Subfolder paths arrive in the
//    filesCollected `dirs` array; when the folder is expanded later,
//    renderLocalDir re-applies state.selected — subfolders absent from it
//    would come back UNCHECKED while their files show checked.
srcChkBox.checked = true;
srcChkBox.dispatchEvent(new window.Event('change'));
window.dispatchEvent(new window.MessageEvent('message', {
  data: { type: 'filesCollected', dirPath: 'D:/proj/src', files: ['D:/proj/src/a.py', 'D:/proj/src/sub/b.py'], dirs: ['D:/proj/src/sub'] },
}));
const srcTwisty2 = srcNode2.querySelector(':scope > .row .twisty');
srcTwisty2.click(); // expand (posts readDir)
window.dispatchEvent(new window.MessageEvent('message', {
  data: { type: 'dir', dirPath: 'D:/proj/src', entries: [
    { name: 'sub', path: 'D:/proj/src/sub', isDir: true, excluded: false },
    { name: 'a.py', path: 'D:/proj/src/a.py', isDir: false, excluded: false },
  ] },
}));
const subChk = localTreeEl.querySelector('.node[data-path="D:/proj/src/sub"] input.chk');
const aChkAfter = localTreeEl.querySelector('.node[data-path="D:/proj/src/a.py"] input.chk');
ok(!!subChk && !!aChkAfter, 'expanded folder renders subfolder and file');
ok(subChk.checked === true && aChkAfter.checked === true, 'subfolder inside checked folder is checked after expand');
ok(srcChkBox.checked === true && srcChkBox.indeterminate === false, 'parent stays fully checked, not half-check');
// restore: uncheck src so the tri-state tests below start clean.
srcChkBox.checked = false;
srcChkBox.dispatchEvent(new window.Event('change'));
window.dispatchEvent(new window.MessageEvent('message', {
  data: { type: 'filesCollected', dirPath: 'D:/proj/src', files: ['D:/proj/src/a.py', 'D:/proj/src/sub/b.py'], dirs: ['D:/proj/src/sub'] },
}));
ok(subChk.checked === false && aChkAfter.checked === false, 'unchecking folder clears subfolders too');

// 2) tri-state: partial → indeterminate, all → checked, none → unchecked.
window.dispatchEvent(new window.MessageEvent('message', {
  data: { type: 'dir', dirPath: 'D:/proj/src', entries: [
    { name: 'a.py', path: 'D:/proj/src/a.py', isDir: false, excluded: false },
    { name: 'b.py', path: 'D:/proj/src/b.py', isDir: false, excluded: false },
  ] },
}));
const aBox = localTreeEl.querySelector('.node[data-path="D:/proj/src/a.py"] input.chk');
const bBox = localTreeEl.querySelector('.node[data-path="D:/proj/src/b.py"] input.chk');
ok(!!aBox && !!bBox, 'src subtree rendered');
aBox.checked = true;
aBox.dispatchEvent(new window.Event('change'));
ok(srcChkBox.indeterminate === true && srcChkBox.checked === false, 'partial selection → folder indeterminate');
bBox.checked = true;
bBox.dispatchEvent(new window.Event('change'));
ok(srcChkBox.checked === true && srcChkBox.indeterminate === false, 'all selected → folder checked');
aBox.checked = false;
aBox.dispatchEvent(new window.Event('change'));
ok(srcChkBox.indeterminate === true, 'partial again → indeterminate');
bBox.checked = false;
bBox.dispatchEvent(new window.Event('change'));
ok(srcChkBox.checked === false && srcChkBox.indeterminate === false, 'none selected → folder unchecked');

// Box-selecting a tri-state folder clears its indeterminate so it visibly
// becomes checked (not a stale half-check).
srcChkBox.indeterminate = true;
srcChkBox.checked = false;
fire(localTreeEl, 'pointerdown', 5, 25);
fire(window, 'pointermove', 150, 35); // covers src
fire(window, 'pointerup', 150, 35);
ok(srcChkBox.checked === true && srcChkBox.indeterminate === false, 'box-select clears folder tri-state');

// Regression: box-selecting a FOLDER together with a file must not let the
// file's change handler re-derive the folder back to unchecked (its children
// are not flipped yet). The pending guard keeps the folder's own toggle.
// Reset first: collapse src, uncheck everything.
srcChkBox.checked = false;
srcChkBox.dispatchEvent(new window.Event('change'));
window.dispatchEvent(new window.MessageEvent('message', {
  data: { type: 'filesCollected', dirPath: 'D:/proj/src', files: ['D:/proj/src/a.py', 'D:/proj/src/b.py'], dirs: [] },
}));
aBox.checked = false;
aBox.dispatchEvent(new window.Event('change'));
bBox.checked = false;
bBox.dispatchEvent(new window.Event('change'));
// src row {0,20,200,40} and package.json row {0,40,200,60} are inside the box.
fire(localTreeEl, 'pointerdown', 5, 25);
fire(window, 'pointermove', 150, 55);
fire(window, 'pointerup', 150, 55);
ok(
  srcChkBox.checked === true,
  'box-select keeps folder checked while files toggle (pending guard)',
);
ok(
  srcChkBox.indeterminate === false,
  'box-selected folder shows fully checked, not half-check',
);

// SSH session closed: the live list no longer contains the active connection
// → the indicator turns grey and the sync buttons disable.
window.dispatchEvent(new window.MessageEvent('message', {
  data: { type: 'state', localBase: 'D:/proj', remoteBase: '/root/data', connId: '183.147.142.40:31592', connLabel: 'root@183.147.142.40', connected: true, backup: false, excludes: [] },
}));
ok(window.document.getElementById('conn-status').classList.contains('on'), 'indicator green while connected');
window.dispatchEvent(new window.MessageEvent('message', {
  data: { type: 'connections', list: [], activeId: '183.147.142.40:31592' },
}));
ok(!window.document.getElementById('conn-status').classList.contains('on'), 'indicator grey after session closes');
ok(window.document.getElementById('btn-preview').disabled, 'preview disabled after disconnect');
ok(
  window.document.getElementById('remote-tree').querySelector('.placeholder'),
  'remote tree cleared on disconnect',
);

// Streaming preview: queueItem messages append one row at a time, then the
// final queue sync renders the same rows.
window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'queue', items: [], mode: 'preview' } }));
window.dispatchEvent(new window.MessageEvent('message', {
  data: { type: 'queueItem', mode: 'preview', item: { relPath: 'src/a.py', status: 'new', size: 1, mtimeMs: 1 } },
}));
ok(window.document.querySelectorAll('#queue-list .qitem').length === 1, 'first queueItem row appended');
window.dispatchEvent(new window.MessageEvent('message', {
  data: { type: 'queueItem', mode: 'preview', item: { relPath: 'src/b.py', status: 'overwrite', size: 1, mtimeMs: 1 } },
}));
ok(window.document.querySelectorAll('#queue-list .qitem').length === 2, 'second queueItem row appended');
ok(
  window.document.querySelectorAll('#queue-list .qitem')[1].textContent.includes('src/b.py'),
  'rows appended in order',
);
window.dispatchEvent(new window.MessageEvent('message', {
  data: { type: 'queue', mode: 'preview', items: [
    { relPath: 'src/a.py', status: 'new', size: 1, mtimeMs: 1 },
    { relPath: 'src/b.py', status: 'overwrite', size: 1, mtimeMs: 1 },
  ] },
}));
ok(window.document.querySelectorAll('#queue-list .qitem').length === 2, 'final queue sync renders same rows');

// Preview click clears the queue IMMEDIATELY, superseding any stale streaming
// rows that are still arriving from a previous run.
window.dispatchEvent(new window.MessageEvent('message', {
  data: { type: 'state', localBase: 'D:/proj', remoteBase: '/root/data', connId: 'x', connLabel: 'x', connected: true, backup: false, excludes: [] },
}));
const pkgBox = localTreeEl.querySelector('.node[data-path="D:/proj/package.json"] input.chk');
pkgBox.checked = true;
pkgBox.dispatchEvent(new window.Event('change'));
window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'queue', items: [], mode: 'preview' } }));
ok(window.document.querySelectorAll('#queue-list .qitem').length === 0, 'queue emptied before stale check');
window.dispatchEvent(new window.MessageEvent('message', {
  data: { type: 'queueItem', mode: 'preview', item: { relPath: 'stale.py', status: 'new', size: 1, mtimeMs: 1 } },
}));
ok(window.document.querySelectorAll('#queue-list .qitem').length === 1, 'stale streaming row present');
// Consume the click-suppression guard (a real browser fires a click after a
// drag's mouseup; jsdom does not, so emit it here as in production).
window.document.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
window.document.getElementById('btn-preview').click();
ok(window.document.querySelectorAll('#queue-list .qitem').length === 0, 'preview click clears queue immediately');

// Refresh during a streaming preview: the queue is cleared, the extension is
// asked to cancel the in-flight diff, and any stale queueItem rows that still
// arrive are ignored until the next Preview.
window.dispatchEvent(new window.MessageEvent('message', {
  data: { type: 'queueItem', mode: 'preview', item: { relPath: 'stream1.py', status: 'new', size: 1, mtimeMs: 1 } },
}));
ok(window.document.querySelectorAll('#queue-list .qitem').length === 1, 'streaming row present before refresh');
window.document.getElementById('btn-refresh').click();
ok(window.document.querySelectorAll('#queue-list .qitem').length === 0, 'refresh clears queue mid-preview');
ok(sent.some((m) => m.type === 'cancelPreview'), 'refresh asks extension to cancel preview');
window.dispatchEvent(new window.MessageEvent('message', {
  data: { type: 'queueItem', mode: 'preview', item: { relPath: 'stale2.py', status: 'new', size: 1, mtimeMs: 1 } },
}));
ok(window.document.querySelectorAll('#queue-list .qitem').length === 0, 'stale queueItem ignored after refresh');
// A new Preview re-enables streaming.
pkgBox.checked = true;
pkgBox.dispatchEvent(new window.Event('change'));
window.document.getElementById('btn-preview').click();
window.dispatchEvent(new window.MessageEvent('message', {
  data: { type: 'queueItem', mode: 'preview', item: { relPath: 'fresh.py', status: 'new', size: 1, mtimeMs: 1 } },
}));
ok(window.document.querySelectorAll('#queue-list .qitem').length === 1, 'streaming resumes after new preview');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
