# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.4] - 2026-08-09

### Fixed

- Box-select in the local tree no longer gets stuck when the drag is released past the bottom edge of the panel: the release happened outside the webview, so the old `mouseup` never fired and the selection rectangle stayed on screen without selecting anything. Drags now use pointer capture — a release anywhere still toggles the boxed rows and the rectangle always disappears

## [0.0.3] - 2026-08-09

### Fixed

- Live connection scanning on Windows now forces PowerShell to emit UTF-8, so non-ASCII SSH config aliases (e.g. `Host 算力自由T4`) are decoded correctly instead of surfacing as mojibake (`��������T4`) that never matches the config entry and fails to connect with `getaddrinfo EINVAL`
- Checking a folder now selects the subfolders inside it as well as the files: previously only the files were tracked, so a folder checked while still collapsed came back with its subfolders unchecked — and the parent showing a half-check — the moment it was expanded

## [0.0.2] - 2026-08-08

### Changed

- New extension icon

## [0.0.1] - 2026-08-08

### Added

- Full-screen webview panel with four columns: local file tree, remote reference tree, transfer queue, and log
- Activity Bar entry: click the icon → panel opens full-screen, sidebar auto-closes
- **Live connection detection**: the dropdown lists only SSH sessions that are open *right now*, found by scanning `ssh`/`ssh.exe` processes at the OS level (Windows: PowerShell `Get-CimInstance`; POSIX: `ps`), auto-refreshing every 5 seconds. The current connection is marked and pre-selected.
- Connection parameters (port, user, identity file) auto-resolved from `~/.ssh/config` when the target host has an entry; command-line `-p` / `-l` / `user@host` also parsed
- Remote base picker: breadcrumb + directory list + "Select this dir"
- Local base, remote base, and last-used connection remembered across sessions
- Relative-path upload with overwrite-only semantics: **never deletes remote files**
- Incremental skip for files identical on both sides (size + mtime)
- Path-traversal guard: relative paths escaping the remote base are rejected
- `.gitignore`-aware excludes: entries matching `syncAnchor.excludes` **or** the local base's `.gitignore` are greyed out with an `excluded` badge and a disabled checkbox
- Configurable exclude patterns (`syncAnchor.excludes`, default `.git`)
- Optional backup of overwritten remote files to `~/.sync-anchor-backup/<timestamp>/`
- Folder tri-state selection: checking a folder recursively checks its contents, partial selection shows an indeterminate half-check, unchecking propagates to children; queue deduplicated by relative path
- Drag-to-box-select in the local tree (desktop-style selection rectangle, toggle semantics, clamps to viewport, starts even in the gutter left of the tree)
- Streaming preview: files appear in the transfer queue one by one as they are compared with the remote, each marked `new` / `overwrite` / `skip`, with auto-scroll
- Selection auto-clears after a successful upload; Refresh clears the queue and cancels an in-progress preview (stale diff results are discarded)
- Disconnect detection: closing the SSH session greys the connection indicator, clears the remote tree, and disables Preview/Upload
- Log capped at 2000 lines with a Clear button; mirrored to the "SyncAnchor" Output channel
- Live diff error classification: `ENOENT` means *new file*, other stat failures (e.g. dropped connection) are surfaced as `error` instead of being mislabelled
