<div align="center">

<img src="media/icon.png" width="96" alt="Sync Anchor logo">

# **Sync Anchor**

**Copy selected local files to Remote Server just on your VSCode.**

*The local-edit → remote-run workflow for AI Coding Agents: Agents change files on your machine, Sync Anchor pushes the exact selection to the server where tests, training, and GPU jobs run.*

<p>

[![license](https://img.shields.io/badge/license-MIT-green?style=for-the-badge)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS_Code-%5E1.85.0-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![Node](https://img.shields.io/badge/Node-18%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux-lightgrey?style=for-the-badge)](https://github.com/DonaldTrump-coder/SyncAnchor)
[![ssh2](https://img.shields.io/badge/ssh2-SFTP-CB3837?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/ssh2)
[![last commit](https://img.shields.io/github/last-commit/DonaldTrump-coder/SyncAnchor?style=for-the-badge)](https://github.com/DonaldTrump-coder/SyncAnchor/commits/main)

</p>

</div>

---

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
npm test             # engine + webview (jsdom) suites, 124 assertions
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
