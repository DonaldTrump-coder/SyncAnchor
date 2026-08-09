// Sync Anchor panel frontend — talks to the extension host over postMessage.

(function () {
  'use strict';

  /** @type {import('vscode').WebviewApi} */
  const vscode = acquireVsCodeApi();

  // Surface any JS error into the log area (and console) for diagnosis.
  window.addEventListener('error', (e) => {
    try {
      appendLog('⛔ JS error: ' + e.message + ' @' + (e.filename || '') + ':' + e.lineno);
    } catch (_) {
      /* ignore */
    }
  });

  const state = {
    localBase: undefined,
    remoteBase: undefined,
    homeDir: undefined,
    pickerPath: undefined,
    remoteTreeRoot: undefined,
    connId: undefined,
    connected: false,
    backup: false,
    excludes: [],
    selected: new Set(), // absolute local paths
    queue: [],
    previewing: true, // streaming preview rows are accepted while true
  };

  const localChildren = new Map(); // dirPath -> children container element
  const remoteChildren = new Map(); // dirPath -> children container element

  const $ = (id) => document.getElementById(id);
  const connSelect = $('conn-select');
  const btnConnect = $('btn-connect');
  const connStatus = $('conn-status');
  const localBaseInput = $('local-base');
  const btnLocal = $('btn-local');
  const remoteBaseInput = $('remote-base');
  const btnRemote = $('btn-remote');
  const chkBackup = $('chk-backup');
  const btnPreview = $('btn-preview');
  const btnUpload = $('btn-upload');
  const btnRefresh = $('btn-refresh');
  const localTree = $('local-tree');
  const remoteTree = $('remote-tree');
  const queueList = $('queue-list');
  const queueCount = $('queue-count');
  const logEl = $('log');
  const btnLogClear = $('btn-log-clear');
  const progress = $('progress');
  const progressBar = $('progress-bar');
  const progressText = $('progress-text');
  // remote base picker
  const picker = $('remote-picker');
  const pickerCrumbs = $('picker-crumbs');
  const pickerDirs = $('picker-dirs');
  const pickerPathEl = $('picker-path');
  const pickerOk = $('picker-ok');
  const btnRemotePicker = $('btn-remote-picker');

  // ---------- messaging ----------

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'state':
        applyState(m);
        break;
      case 'connections':
        renderConnections(m.list, m.activeId);
        break;
      case 'dir':
        renderLocalDir(m.dirPath, m.entries);
        break;
      case 'remoteDir':
        renderRemoteDir(m.dirPath, m.entries);
        break;
      case 'homeDir':
        state.homeDir = m.path;
        if (state.connected && !state.remoteBase) {
          ensureRemoteRoot(m.path);
          if (!remoteChildren.get(m.path)?.childElementCount) {
            post({ type: 'readRemoteDir', dirPath: m.path });
          }
        }
        break;
      case 'filesCollected':
        applyDirSelection(m.dirPath, m.files, m.dirs);
        break;
      case 'queue':
        renderQueue(m.items, m.mode);
        break;
      case 'queueItem':
        // Streaming preview: append one row as the extension diffs it. Rows
        // arriving after a Refresh (stale in-flight preview) are ignored.
        if (m.mode === 'preview' && state.previewing) {
          state.queue.push(m.item);
          queueList.appendChild(makeQueueItemEl(m.item));
          queueCount.textContent = queueCountText(state.queue, 'preview');
          // Keep the newest row in view.
          queueList.scrollTop = queueList.scrollHeight;
        }
        break;
      case 'uploadDone':
        if (!m.hasErrors) {
          clearSelection();
          appendLog('✓ Upload finished — selection cleared');
        } else {
          appendLog('⚠ Some files failed — selection kept for retry');
        }
        break;
      case 'progress':
        renderProgress(m);
        break;
      case 'log':
        appendLog(m.line);
        break;
      case 'status':
        setStatus(m.text, m.ok);
        break;
      case 'error':
        appendLog('❌ ' + m.message);
        break;
    }
  });

  function post(m) {
    vscode.postMessage(m);
  }

  // ---------- state ----------

  function applyState(s) {
    state.localBase = s.localBase;
    state.remoteBase = s.remoteBase;
    state.connId = s.connId;
    state.connected = !!s.connected;
    state.backup = !!s.backup;
    state.excludes = s.excludes || [];

    localBaseInput.value = s.localBase || '';
    remoteBaseInput.value = s.remoteBase || '';
    chkBackup.checked = state.backup;

    setStatus(
      state.connected
        ? 'Connected: ' + (s.connLabel || s.connId)
        : s.connId
          ? 'Not connected: ' + (s.connLabel || s.connId)
          : 'Not connected',
      state.connected,
    );

    if (state.localBase) {
      ensureLocalRoot();
      if (!localChildren.get(state.localBase)?.childElementCount) {
        post({ type: 'readDir', dirPath: state.localBase });
      }
    } else {
      localTree.innerHTML = '<div class="placeholder">Pick a local base folder to browse.</div>';
      localChildren.clear();
    }

    if (state.connected) {
      if (state.remoteBase) {
        ensureRemoteRoot(state.remoteBase);
        if (!remoteChildren.get(state.remoteBase)?.childElementCount) {
          post({ type: 'readRemoteDir', dirPath: state.remoteBase });
        }
      }
      // No base yet: the homeDir message starts the browse tree.
    } else {
      remoteTree.innerHTML =
        '<div class="placeholder">Connect to browse the remote filesystem.</div>';
      remoteChildren.clear();
    }

    updateButtons();
  }

  function setStatus(text, ok) {
    connStatus.className = 'status-dot ' + (ok ? 'on' : 'off');
    connStatus.title = text;
  }

  // ---------- connections ----------

  function renderConnections(list, activeId) {
    connSelect.innerHTML = '';
    appendLog('ℹ Connection list loaded: ' + list.length + ' candidate(s)');
    if (!list.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = 'No live SSH connection — connect via ssh first';
      connSelect.appendChild(o);
      appendLog('⚠ No live SSH connection detected. Start one first, e.g. terminal: ssh root@server');
    } else {
      for (const c of list) {
        const o = document.createElement('option');
        o.value = c.id;
        o.textContent = (c.current ? '● ' : '') + c.label + (c.current ? ' (current)' : '');
        o.title = c.user + '@' + c.host + ':' + c.port + (c.keyPath ? ' · key ' + c.keyPath : '');
        connSelect.appendChild(o);
      }
      const idx = list.findIndex((c) => c.id === activeId);
      connSelect.selectedIndex = idx >= 0 ? idx : 0; // default to active, else first
    }
    btnConnect.disabled = !connSelect.value;

    // Fallback check: if we were connected but the active session is no longer
    // in the live list (SSH closed), turn the indicator grey and disable the
    // sync buttons. The extension normally sends a status first; this guards
    // the UI even if that message is missed.
    const stillConnected = state.connected && list.some((c) => c.id === (activeId || state.connId));
    if (state.connected && !stillConnected) {
      state.connected = false;
      setStatus('Not connected: SSH session closed', false);
      updateButtons();
      // The remote reference tree is meaningless without a live session —
      // clear it so stale listings cannot be mistaken for fresh ones.
      remoteTree.innerHTML = '<div class="placeholder">Disconnected — connect via ssh to browse.</div>';
      remoteChildren.clear();
      appendLog('⚠ SSH session closed — disconnected');
    }
  }

  // ---------- local tree ----------

  function ensureLocalRoot() {
    if (localChildren.has(state.localBase)) {
      return;
    }
    localTree.innerHTML = '';
    const root = document.createElement('div');
    root.className = 'node dir';
    const row = document.createElement('div');
    row.className = 'row';
    const twisty = document.createElement('span');
    twisty.className = 'twisty';
    twisty.textContent = '▾';
    const name = document.createElement('span');
    name.className = 'name dir-name';
    name.textContent = state.localBase;
    row.appendChild(twisty);
    row.appendChild(name);
    const children = document.createElement('div');
    children.className = 'children';
    root.appendChild(row);
    root.appendChild(children);
    localTree.appendChild(root);
    localChildren.set(state.localBase, children);
    twisty.addEventListener('click', () => {
      const collapsed = children.style.display === 'none';
      twisty.textContent = collapsed ? '▾' : '▸';
      children.style.display = collapsed ? '' : 'none';
    });
  }

  function renderLocalDir(dirPath, entries) {
    const children = localChildren.get(dirPath);
    if (!children) {
      return; // stale response after base switch
    }
    children.innerHTML = '';
    for (const e of entries) {
      children.appendChild(makeLocalNode(e));
    }
    // Re-apply any persisted selection to freshly rendered nodes, then sync
    // the folder tri-states.
    for (const chk of children.querySelectorAll('input.chk:not(:disabled)')) {
      const node = chk.closest('.node');
      if (node && node.dataset.path && state.selected.has(node.dataset.path)) {
        chk.checked = true;
      }
    }
    updateDirStates();
    if (!children.childElementCount) {
      children.appendChild(el('div', 'placeholder', '(empty)'));
    }
  }

  function makeLocalNode(entry) {
    const div = el('div', 'node ' + (entry.isDir ? 'dir' : 'file'));
    div.dataset.path = entry.path;
    const row = el('div', 'row');
    const twisty = el('span', 'twisty', entry.isDir ? '▸' : '');
    const label = el('label', 'chk-row');
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'chk';
    const name = el('span', 'name' + (entry.isDir ? ' dir-name' : ''), entry.name);
    if (entry.excluded) {
      // Excluded entries are visible but greyed out and not selectable.
      div.classList.add('excluded');
      name.appendChild(el('span', 'ex-badge', 'excluded'));
      chk.disabled = true;
    }
    label.appendChild(chk);
    label.appendChild(name);
    row.appendChild(twisty);
    row.appendChild(label);
    div.appendChild(row);

    if (entry.isDir) {
      const children = el('div', 'children');
      div.appendChild(children);
      localChildren.set(entry.path, children);
      const toggle = () => {
        const collapsed = children.style.display === 'none' || !div.dataset.loaded;
        twisty.textContent = collapsed ? '▾' : '▸';
        children.style.display = collapsed ? '' : 'none';
        if (collapsed) {
          if (!div.dataset.loaded) {
            div.dataset.loaded = '1';
            if (!children.childElementCount) {
              // Instant feedback while the dir is being listed.
              children.appendChild(el('div', 'placeholder', '(loading…)'));
            }
          }
          // Always re-request: expanding an already-loaded folder refreshes
          // its contents (files may have changed on disk since last time).
          post({ type: 'readDir', dirPath: entry.path });
        }
      };
      twisty.addEventListener('click', toggle);
      row.addEventListener('click', (e) => {
        // The twisty has its own listener — without this guard its click would
        // bubble here and toggle a SECOND time (expand then instantly collapse).
        if (e.target === twisty) {
          return;
        }
        if (e.target === row || e.target === name || e.target === label) {
          toggle();
        }
      });
      chk.addEventListener('change', () => {
        // Folder: ask the extension for its full subtree, then check/uncheck
        // every file so folder and contents stay consistent. While the
        // response is pending, updateDirStates must NOT re-derive this box
        // from its (still unchanged) children — that would undo the toggle.
        div.dataset.pending = chk.checked ? '1' : '';
        post({ type: 'collectFiles', dirPath: entry.path });
      });
    } else {
      chk.addEventListener('change', () => {
        onLocalCheck(entry.path, chk.checked);
        updateDirStates();
      });
    }
    return div;
  }

  function onLocalCheck(absPath, checked) {
    if (checked) {
      state.selected.add(absPath);
    } else {
      state.selected.delete(absPath);
    }
    updateButtons();
  }

  /** Uncheck every node and drop the selection (after upload/refresh). */
  function clearSelection() {
    state.selected.clear();
    for (const chk of localTree.querySelectorAll('input.chk:checked')) {
      chk.checked = false;
    }
    updateDirStates();
    updateButtons();
  }

  // ---------- folder <-> contents selection consistency ----------

  /** Find a node's own checkbox by its absolute path (no selector escaping). */
  function findBox(absPath) {
    const node = findNodeEl(absPath);
    if (!node) {
      return null;
    }
    const row = node.querySelector(':scope > .row');
    return row ? row.querySelector('input.chk') : null;
  }

  /** Find the tree node element by its absolute path. */
  function findNodeEl(absPath) {
    for (const node of localTree.querySelectorAll('.node')) {
      if (node.dataset.path === absPath) {
        return node;
      }
    }
    return null;
  }

  /**
   * Apply a folder check/uncheck to its whole subtree (files and loaded
   * subfolder boxes). Reads the folder's CURRENT checkbox state, so concurrent
   * collectFiles responses cannot race each other.
   */
  function applyDirSelection(dirPath, files, dirs) {
    const selfBox = findBox(dirPath);
    const checked = selfBox ? selfBox.checked : true;
    for (const f of files) {
      if (checked) {
        state.selected.add(f);
      } else {
        state.selected.delete(f);
      }
      const box = findBox(f);
      if (box && !box.disabled) {
        box.checked = checked;
      }
    }
    for (const d of dirs) {
      // Track subfolders in the selection too, not just files: the tree
      // re-applies state.selected to freshly rendered nodes on expand, so a
      // subfolder skipped here (its node not yet in the DOM) would come back
      // UNCHECKED while its files show checked — "folder check selects the
      // files but not the folders inside".
      if (checked) {
        state.selected.add(d);
      } else {
        state.selected.delete(d);
      }
      const box = findBox(d);
      if (box && !box.disabled) {
        box.checked = checked;
        box.indeterminate = false;
      }
    }
    // The collectFiles round-trip is done — release the tri-state guard.
    const node = findNodeEl(dirPath);
    if (node) {
      node.dataset.pending = '';
    }
    updateDirStates();
    updateButtons();
    appendLog((checked ? '✓ Selected folder ' : '✗ Unselected folder ') + dirPath + ' (' + files.length + ' files)');
  }

  /**
   * Sync every folder checkbox with its loaded children: all checked → checked,
   * some → indeterminate, none → unchecked. Deepest folders first.
   */
  function updateDirStates() {
    const dirs = [...localTree.querySelectorAll('.node.dir')];
    for (let i = dirs.length - 1; i >= 0; i--) {
      const d = dirs[i];
      const chk = d.querySelector(':scope > .row input.chk');
      if (!chk || chk.disabled) {
        continue;
      }
      if (d.dataset.pending === '1') {
        continue; // folder check awaiting collectFiles response
      }
      const childBoxes = [...d.querySelectorAll(':scope > .children > .node > .row input.chk')].filter(
        (b) => !b.disabled,
      );
      if (!childBoxes.length) {
        continue; // subtree not loaded yet — leave the folder checkbox alone
      }
      const sel = childBoxes.filter((b) => b.checked && !b.indeterminate).length;
      const ind = childBoxes.filter((b) => b.indeterminate).length;
      if (sel === childBoxes.length) {
        chk.checked = true;
        chk.indeterminate = false;
      } else if (sel > 0 || ind > 0) {
        chk.checked = false;
        chk.indeterminate = true;
      } else {
        chk.checked = false;
        chk.indeterminate = false;
      }
    }
  }

  // ---------- remote tree ----------

  function ensureRemoteRoot(rootPath) {
    // Reset the whole tree whenever the root changes (base picked / connect),
    // so the reference tree always matches the current remote base.
    if (state.remoteTreeRoot !== rootPath || !remoteChildren.has(rootPath)) {
      remoteTree.innerHTML = '';
      remoteChildren.clear();
      state.remoteTreeRoot = rootPath;
    } else {
      return;
    }
    const root = el('div', 'node dir');
    const row = el('div', 'row');
    const twisty = el('span', 'twisty', '▾');
    const name = el('span', 'name dir-name', rootPath);
    row.appendChild(twisty);
    row.appendChild(name);
    const children = el('div', 'children');
    root.appendChild(row);
    root.appendChild(children);
    remoteTree.appendChild(root);
    remoteChildren.set(rootPath, children);
    twisty.addEventListener('click', () => {
      const collapsed = children.style.display === 'none';
      twisty.textContent = collapsed ? '▾' : '▸';
      children.style.display = collapsed ? '' : 'none';
    });
  }

  function renderRemoteDir(dirPath, entries) {
    const children = remoteChildren.get(dirPath);
    if (children) {
      children.innerHTML = '';
      for (const e of entries) {
        children.appendChild(makeRemoteNode(e, dirPath));
      }
      if (!children.childElementCount) {
        children.appendChild(el('div', 'placeholder', '(empty)'));
      }
    }
    // Keep the base picker in sync when it is browsing this path.
    if (!picker.hidden && state.pickerPath === dirPath) {
      renderPickerDirs(entries);
    }
  }

  function makeRemoteNode(entry, parentPath) {
    const div = el('div', 'node ' + (entry.isDir ? 'dir' : 'file'));
    const row = el('div', 'row');
    const twisty = el('span', 'twisty', entry.isDir ? '▸' : '');
    const name = el('span', 'name' + (entry.isDir ? ' dir-name' : ''), entry.name);
    row.appendChild(twisty);
    row.appendChild(name);
    div.appendChild(row);

    if (entry.isDir) {
      const children = el('div', 'children');
      div.appendChild(children);
      remoteChildren.set(parentPath + '/' + entry.name, children);
      const toggle = () => {
        const collapsed = children.style.display === 'none' || !div.dataset.loaded;
        twisty.textContent = collapsed ? '▾' : '▸';
        children.style.display = collapsed ? '' : 'none';
        if (collapsed && !div.dataset.loaded) {
          div.dataset.loaded = '1';
          if (!children.childElementCount) {
            // Instant feedback while the SFTP listing is in flight.
            children.appendChild(el('div', 'placeholder', '(loading…)'));
          }
          post({ type: 'readRemoteDir', dirPath: parentPath + '/' + entry.name });
        }
      };
      twisty.addEventListener('click', toggle);
      row.addEventListener('click', (e) => {
        // Guard against the twisty's click bubbling here and toggling twice.
        if (e.target === twisty) {
          return;
        }
        if (e.target === row || e.target === name) {
          toggle();
        }
      });
    }
    return div;
  }

  // ---------- remote base picker ----------

  function openPicker() {
    if (!state.connected) {
      appendLog('⚠ Connect first, then pick a remote base');
      return;
    }
    state.pickerPath = state.remoteBase || state.homeDir || '/';
    const r = remoteBaseInput.getBoundingClientRect();
    picker.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 440)) + 'px';
    picker.style.top = (r.bottom + 6) + 'px';
    picker.hidden = false;
    appendLog('Picker opened at ' + state.pickerPath);
    renderPickerCrumbs();
    pickerDirs.innerHTML = '<div class="placeholder">Loading…</div>';
    post({ type: 'readRemoteDir', dirPath: state.pickerPath });
  }

  function closePicker() {
    picker.hidden = true;
  }

  function renderPickerCrumbs() {
    pickerCrumbs.innerHTML = '';
    pickerPathEl.textContent = state.pickerPath || '';
    const parts = (state.pickerPath || '/').split('/').filter(Boolean);
    let acc = '';
    const addCrumb = (label, path, last) => {
      const crumb = el('span', 'crumb', label || '/');
      crumb.title = path;
      if (!last) {
        crumb.addEventListener('click', (e) => {
          e.stopPropagation(); // keep picker open (document-click would close it)
          state.pickerPath = path;
          appendLog('Picker → ' + path);
          renderPickerCrumbs();
          pickerDirs.innerHTML = '<div class="placeholder">Loading…</div>';
          post({ type: 'readRemoteDir', dirPath: path });
        });
      }
      pickerCrumbs.appendChild(crumb);
      if (!last) {
        pickerCrumbs.appendChild(el('span', 'crumb-sep', '/'));
      }
    };
    if (!parts.length) {
      addCrumb('/', '/', true);
    } else {
      addCrumb('/', '/', false);
      for (let i = 0; i < parts.length; i++) {
        acc += '/' + parts[i];
        addCrumb(parts[i], acc, i === parts.length - 1);
      }
    }
  }

  function renderPickerDirs(entries) {
    pickerDirs.innerHTML = '';
    pickerPathEl.textContent = state.pickerPath || '';
    const dirs = entries.filter((e) => e.isDir).sort((a, b) => a.name.localeCompare(b.name));
    if (!dirs.length) {
      pickerDirs.appendChild(el('div', 'placeholder', '(no subdirectories)'));
      return;
    }
    for (const d of dirs) {
      const row = el('div', 'picker-dir');
      const icon = el('span', 'twisty', '▸');
      const name = el('span', 'name dir-name', d.name);
      row.appendChild(icon);
      row.appendChild(name);
      row.addEventListener('click', (e) => {
        e.stopPropagation(); // keep picker open (document-click would close it)
        const base = state.pickerPath.endsWith('/') ? state.pickerPath : state.pickerPath + '/';
        const next = base + d.name;
        state.pickerPath = next;
        appendLog('Picker → ' + next);
        renderPickerCrumbs();
        pickerDirs.innerHTML = '<div class="placeholder">Loading…</div>';
        post({ type: 'readRemoteDir', dirPath: next });
      });
      pickerDirs.appendChild(row);
    }
  }

  // ---------- queue ----------

  const BADGES = {
    new: ['+', 'new'],
    overwrite: ['↻', 'overwrite'],
    skip: ['⏭', 'skip'],
    done: ['✓', 'done'],
    error: ['✗', 'error'],
  };

  function makeQueueItemEl(it) {
    const badgeSpec = BADGES[it.status] || ['?', ''];
    const div = el('div', 'qitem');
    const badge = el('span', 'badge ' + badgeSpec[1], badgeSpec[0]);
    const text = el('span', 'qpath', it.relPath + (it.error ? ' — ' + it.error : ''));
    div.appendChild(badge);
    div.appendChild(text);
    return div;
  }

  function queueCountText(items, mode) {
    const transferable = items.filter((i) => i.status !== 'skip').length;
    return items.length + ' file(s)' + (mode === 'preview' ? ' · ' + transferable + ' to transfer' : '');
  }

  function renderQueue(items, mode) {
    state.queue = items;
    queueList.innerHTML = '';
    queueCount.textContent = queueCountText(items, mode);
    for (const it of items) {
      queueList.appendChild(makeQueueItemEl(it));
    }
    if (!items.length) {
      queueList.appendChild(el('div', 'placeholder', 'Select files, then press Preview.'));
    }
    updateButtons();
  }

  // ---------- progress & log ----------

  function renderProgress(m) {
    progress.hidden = false;
    progressBar.style.width = (m.total ? Math.round((m.done / m.total) * 100) : 0) + '%';
    progressText.textContent = m.done + '/' + m.total + ' ' + m.current;
    if (m.done >= m.total) {
      setTimeout(() => {
        progress.hidden = true;
      }, 1500);
    }
  }

  function appendLog(line) {
    const div = document.createElement('div');
    div.textContent = line;
    logEl.appendChild(div);
    while (logEl.childElementCount > 2000) {
      logEl.removeChild(logEl.firstChild);
    }
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ---------- buttons ----------

  function updateButtons() {
    btnConnect.disabled = !connSelect.value;
    btnPreview.disabled = !state.connected || state.selected.size === 0;
    btnUpload.disabled = !state.connected || state.queue.length === 0;
  }

  // ---------- events ----------

  connSelect.addEventListener('change', () => {
    btnConnect.disabled = !connSelect.value;
  });

  btnConnect.addEventListener('click', () => {
    const id = connSelect.value;
    if (id) {
      post({ type: 'connect', id });
    }
  });

  btnLocal.addEventListener('click', () => post({ type: 'pickLocalBase' }));

  btnRemote.addEventListener('click', () => {
    const v = remoteBaseInput.value.trim();
    post(v ? { type: 'setRemoteBase', path: v } : { type: 'pickRemoteBase' });
  });

  btnRemotePicker.addEventListener('click', () => {
    if (picker.hidden) {
      openPicker();
    } else {
      closePicker();
    }
  });
  pickerOk.addEventListener('click', () => {
    if (state.pickerPath) {
      appendLog('Remote base set: ' + state.pickerPath);
      post({ type: 'setRemoteBase', path: state.pickerPath });
      closePicker();
    }
  });
  document.addEventListener('click', (e) => {
    if (picker.hidden || picker.contains(e.target) || e.target === btnRemotePicker) {
      return;
    }
    closePicker();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePicker();
    }
  });

  remoteBaseInput.addEventListener('change', () => {
    const v = remoteBaseInput.value.trim();
    if (v) {
      post({ type: 'setRemoteBase', path: v });
    }
  });

  chkBackup.addEventListener('change', () => {
    post({ type: 'setBackup', value: chkBackup.checked });
  });

  btnPreview.addEventListener('click', () => {
    if (!state.selected.size) {
      appendLog('⚠ Nothing selected — check files in the local tree');
      return;
    }
    // Clear immediately so a stale streaming preview cannot interleave with
    // this new run (the extension also supersedes in-flight diffs).
    state.previewing = true;
    state.queue = [];
    renderQueue([], 'preview');
    post({ type: 'preview', selectedPaths: [...state.selected] });
  });

  btnUpload.addEventListener('click', () => {
    post({ type: 'upload' });
  });

  btnRefresh.addEventListener('click', () => {
    // Clear the finished transfer queue and the stale selection on refresh so
    // a fresh Preview starts clean (no leftover checked files). Also cancel any
    // in-flight streaming preview: its rows must not reappear after the clear.
    state.previewing = false;
    post({ type: 'cancelPreview' });
    state.queue = [];
    renderQueue([], 'result');
    clearSelection();
    if (state.localBase) {
      post({ type: 'readDir', dirPath: state.localBase });
    }
    if (state.remoteBase && state.connected) {
      post({ type: 'readRemoteDir', dirPath: state.remoteBase });
    }
    post({ type: 'getConnections' });
    appendLog('⟳ Refreshed');
  });

  btnLogClear.addEventListener('click', () => {
    logEl.innerHTML = '';
    appendLog('Log cleared');
  });

  // ---------- drag-box selection (local tree, desktop-like) ----------

  let dragBox = null;
  let suppressNextClick = false;

  // Listen on document so the drag can start from any blank area of the tree,
  // INCLUDING the strip to its LEFT (the first column starts at the viewport's
  // left edge and users often grab there). Use coordinates, not containment,
  // so the left gutter and the tree's own padding both start a box-select.
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) {
      return;
    }
    if (e.target.closest('input, .twisty, button')) {
      return; // let checkbox/twisty interactions work normally
    }
    const tr = localTree.getBoundingClientRect();
    if (e.clientX < 0 || e.clientX > tr.right || e.clientY < tr.top || e.clientY > tr.bottom) {
      return; // outside the local-tree column
    }
    dragBox = { x0: e.clientX, y0: e.clientY, el: null };
    e.preventDefault(); // avoid text selection while dragging
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragBox) {
      return;
    }
    const dx = e.clientX - dragBox.x0;
    const dy = e.clientY - dragBox.y0;
    if (!dragBox.el && dx * dx + dy * dy > 100) {
      // Moved more than 10px — this is a drag, not a click (10px leaves room
      // for small hand jitter so a plain click still expands/collapses).
      dragBox.el = document.createElement('div');
      dragBox.el.className = 'sel-rect';
      document.body.appendChild(dragBox.el);
      suppressNextClick = true;
      // NOTE: existing selection is kept during the drag; on mouseup the boxed
      // nodes are TOGGLED (checked → unchecked, unchecked → checked), leaving
      // everything outside the box untouched.
    }
    if (dragBox.el) {
      // Clamp to the viewport so the box stays visible when the pointer
      // moves past the left/top edge of the window.
      const left = Math.max(0, Math.min(e.clientX, dragBox.x0));
      const top = Math.max(0, Math.min(e.clientY, dragBox.y0));
      dragBox.el.style.left = left + 'px';
      dragBox.el.style.top = top + 'px';
      dragBox.el.style.width = Math.max(0, Math.abs(dx)) + 'px';
      dragBox.el.style.height = Math.max(0, Math.abs(dy)) + 'px';
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (!dragBox) {
      return;
    }
    if (dragBox.el) {
      const r = {
        left: Math.min(e.clientX, dragBox.x0),
        top: Math.min(e.clientY, dragBox.y0),
        right: Math.max(e.clientX, dragBox.x0),
        bottom: Math.max(e.clientY, dragBox.y0),
      };
      // Two passes over the hit nodes: FIRST flip every checkbox (so a later
      // change handler's updateDirStates sees the FINAL state of all boxed
      // nodes), THEN fire change for each. Without the two passes a boxed
      // file's updateDirStates could re-derive a boxed folder's check from its
      // still-unflipped children and undo it ("box-select won't select it").
      const hits = [];
      for (const n of localTree.querySelectorAll('.node')) {
        const b = n.getBoundingClientRect();
        if (b.right > r.left && b.left < r.right && b.bottom > r.top && b.top < r.bottom) {
          // Only the node's OWN row counts — a descendant query would hit the
          // first child's checkbox (the tree root has no checkbox of its own).
          const row = n.querySelector(':scope > .row');
          const chk = row ? row.querySelector('input[type=checkbox].chk') : null;
          if (chk && !chk.disabled) {
            chk.checked = !chk.checked;
            chk.indeterminate = false;
            hits.push(chk);
          }
        }
      }
      for (const chk of hits) {
        chk.dispatchEvent(new Event('change'));
      }
      dragBox.el.remove();
    }
    dragBox = null;
  });

  // A drag ends with a click event on the tree; swallow that one click so the
  // single-click row behavior (expand/collapse) does not fire after a
  // box-select. The guard is CONSUMED on use (not timer-reset) so a lingering
  // stale click can never eat a later, unrelated click.
  document.addEventListener(
    'click',
    (e) => {
      if (suppressNextClick) {
        suppressNextClick = false;
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true,
  );

  // ---------- helpers ----------

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) {
      e.className = className;
    }
    if (text !== undefined) {
      e.textContent = text;
    }
    return e;
  }

  // init
  appendLog('Sync Anchor panel ready');
  post({ type: 'ready' });
  post({ type: 'getConnections' });
  // Auto-refresh: new ssh connections appear, closed ones disappear.
  setInterval(() => post({ type: 'getConnections' }), 5000);
})();
