# dsh-direct-chat

English | [简体中文](./README.zh-CN.md)

A DeepSeek Harness (`dsh`) plugin that connects **Claude Code**, **Codex**, and **Antigravity CLI (`agy`)** directly into the DSH Web & Desktop interface with unified session management, multi-account isolation, workspace tools, and mobile-friendly UI.

## Features

- **Multi-CLI Direct Integration**: Run and manage `claude`, `codex`, and `agy` sessions from a unified composer and sidebar.
- **Multi-Account & Profile Isolation**: Manage multiple OAuth or environment-based profiles per CLI with per-session account binding and default profile switching.
- **Native History & Archiving**: Import existing terminal CLI sessions and archive/restore sessions back to native CLI storage.
- **Status & Quota Monitoring**: Live context window usage, token throughput (`tok/s`), account quota windows, and a cross-session status monitor (`SessionPet`).
- **Workspace Rightbar**: File tree browser, syntax-highlighted code / Markdown / PDF / spreadsheet / media previews, Git diff review annotations, and embedded PTY terminal.
- **Rich Composer**: `/` slash commands, `@` workspace file & directory mentions with drill-down breadcrumbs, attachments, and queue/steer delivery modes.
- **Mobile & Desktop Responsive**: Adaptive layout for mobile browsers (fullscreen overlays, two-row composer bar, compact status modal).

## Prerequisites

- [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness) installed and available.
- At least one supported CLI installed on your machine (`claude`, `codex`, or `agy`).

## Installation (Prebuilt)

`ui/client.js` is prebuilt and committed in this repository, so no build step is required to use the plugin.

1. Clone this repository into your DSH plugins directory (or any local folder):
   ```bash
   git clone <your-repo-url> direct-chat
   ```
2. Register or link the `direct-chat` directory in your DSH plugin configuration and restart `dsh`.

## Development

Rebuild the frontend bundle (`ui/client.js`) after editing files in `ui/` (requires `dsh` in `PATH` or devDependencies installed):

```bash
npm run build:ui
```

Run tests:

```bash
node --test *.test.mjs ui/*.test.mjs
```
