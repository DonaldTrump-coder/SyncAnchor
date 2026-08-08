# Sync Anchor

Copy selected local files/folders to a remote server over SSH by **relative path** — safely, incrementally, and without ever deleting anything on the remote.

![icon](media/icon.png)

## Why

The most tedious part of "edit locally → test on the GPU box" is pushing code. Sync Anchor pairs a **local base folder** with a **remote base folder**, then uploads only what you select, at the same relative location on the remote.

- **Pick files or whole folders** — a folder is just a shortcut for selecting all files inside it; check a folder and its contents follow (unchecked → checked, partial → half-checked tri-state).
- **Relative-path overwrite** — `src/model.py` from your local base lands at `<remote-base>/src/model.py`.
- **Never deletes anything** — the remote only ever gains or overwrites what you explicitly selected. There is no delete/mirror semantics at all.
- **Incremental** — files whose size and mtime match the remote are skipped automatically.
- **Zero connection setup** — the dropdown lists exactly the servers you are connected to **right now** (detected from running `ssh` processes at the OS level), auto-refreshing every 5 seconds. Open a new `ssh` connection in any terminal and it appears; close it and it disappears.
- **Preview before upload** — each file streams into the queue as it is compared against the remote, so you see exactly which files will be created / overwritten / skipped before anything is touched.
- **`.gitignore`-aware** — your project's ignore rules grey out matching entries (badge + disabled checkbox) so build artifacts and local settings never sneak into an upload.

## Usage

1. Click the **Sync Anchor** icon in the Activity Bar (or run `Sync Anchor: Open Panel`).
2. Pick a connection from the dropdown (only **live** SSH sessions are listed).
3. Set the **local base** (a folder on this machine) and the **remote base** (a folder on the server).
4. Check files/folders in the local tree — box-select for a batch — then click **Preview**.
5. Review the transfer queue (new / overwrite / skip), then **Upload**.

## Features

| | |
|---|---|
| Full-screen panel | Four columns: local tree, remote tree, transfer queue, log |
| Safe by design | No delete path, path-traversal guard, configurable excludes, optional backup before overwrite |
| Incremental | Skips files identical on both sides (size + mtime) |
| Folder selection UX | Check a folder → contents auto-check; partial selection shows a half-check; folder and contents stay consistent |
| Streaming preview | Files appear in the queue one by one as they are diffed, not as one dump |
| Dual-host aware | Works in local windows and Remote-SSH windows |

## Configuration

| Setting | Default | Description |
|---|---|---|
| `syncAnchor.excludes` | `.git`, `node_modules`, `venv`, `__pycache__`, `.vs`, `*.zip` | Glob-like patterns excluded from the tree and uploads |
| `syncAnchor.backupBeforeOverwrite` | `false` | Move remote files to `~/.sync-anchor-backup/<timestamp>/` before overwriting |

## Requirements

- A remote host reachable over SSH, with an entry in `~/.ssh/config` (or a Remote-SSH recent connection)
- Node.js 18+ (only needed for development / publishing)

## Development

```bash
npm install
npm run compile      # tsc → out/
npm test             # 124 assertions across engine + webview (jsdom)
npm run package      # build the .vsix
```

Run the extension with **F5** inside VS Code (launch.json is included).

## Publishing to the VS Code Marketplace

1. Create a publisher on [Visual Studio Marketplace](https://marketplace.visualstudio.com/manage): sign in with a Microsoft account, create a publisher named `donaldtrump-coder`, then create a Personal Access Token with the **Marketplace → Manage** scope.
2. Push this repository to GitHub (`DonaldTrump-coder/SyncAnchor`) and tag it:
   ```bash
   git tag v0.0.1 && git push --tags
   ```
3. Authenticate `vsce` once:
   ```bash
   npm install -g @vscode/vsce
   vsce login donaldtrump-coder
   ```
4. Publish:
   ```bash
   npm run package     # sanity-check the .vsix
   vsce publish        # builds and uploads
   ```
5. Update later versions with `vsce publish patch` / `minor` / `major` (bumps `package.json`, commits, tags, and uploads in one step).

## Release Notes

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
