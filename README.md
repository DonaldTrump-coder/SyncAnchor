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
[![last commit](https://img.shields.io/github/last-commit/DonaldTrump-coder/SyncAnchor?style=for-the-badge)](https://github.com/DonaldTrump-coder/SyncAnchor)

</p>

</div>

---

## Usage of the Extension

1. Click the **Sync Anchor** icon in the Activity Bar (or run `Sync Anchor: Open Panel`).
2. Pick a connection to copy files for (only **live** SSH sessions are listed).
3. Set the **local base** (a folder on your lical machine) and the **remote base** (a folder on the server).
4. Check files/folders in the local tree, select for a batch, and then click **Preview**.
5. Review the transfer queue (new / overwrite / skip), then **Upload**.

![](./media/demo.png)

## Configurations

| Setting | Default | Description |
|---|---|---|
| `syncAnchor.excludes` | `[".git"]` | Glob-like patterns excluded from the tree and uploads. Entries matching the local base's `.gitignore` are excluded too. |
| `syncAnchor.backupBeforeOverwrite` | `false` | Move remote files to `~/.sync-anchor-backup/<timestamp>/` before overwriting. |

## From Source

**Prerequisites**

- A remote host reachable over SSH, with an entry in `~/.ssh/config` (or a Remote-SSH recent connection)
- Node.js 18+

**Build & run**

```bash
npm install
npm run compile      # tsc → out/
npm test             # engine + webview (jsdom) suites, 124 assertions
npm run package      # build the .vsix
```

Run the extension with **F5** inside VS Code (launch.json is included).

## Release Notes

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
