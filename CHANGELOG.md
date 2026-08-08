# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- MVP: full-screen webview panel with local tree (multi-select), transfer queue, and log
- Connection picker: `~/.ssh/config` hosts + Remote-SSH recent connections + current remote window
- Activity Bar entry: click icon → panel opens full-screen, sidebar auto-closes
- Relative-path upload with overwrite-only semantics (never deletes remote files)
- Incremental skip for files identical on both sides (size + mtime)
- Path-traversal guard and configurable excludes
- Optional backup of overwritten remote files to `~/.sync-anchor-backup/<timestamp>/`
