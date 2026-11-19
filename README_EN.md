# HTML Visual Editor (Local Desktop Tool)

English | [简体中文](./README_CN.md)

A lightweight desktop tool for developers: edit HTML **visually**, just like in a word processor. Click any element on the page to modify its text, replace an image, insert content, or delete a block. Saving performs a **source-level precise patch** that preserves every unchanged byte of the original file. You can also hand the local HTML file — together with the element you selected — to a local Agent (codex / cbc) to **edit the file directly**, with an automatic pre-edit backup and one-click restore.

Built with **Tauri 2 + React + TypeScript**. Runs entirely locally with no cloud dependency.

---

## Features

### Manual editing
- **Click to edit**: hover to highlight, click to select a field, then edit text or replace an image in the right panel
- **Insert / delete**: insert text or images relative to the selected element (before / after / prepend / append); delete the selected block
- **Undo / redo**: the manual editing area provides "Undo last step" / "Redo" buttons
- **Source-level precise save**: only the target node's source range is replaced; untouched bytes are preserved exactly, without full-page DOM serialization
- **Change history**: every edit is recorded and can be undone individually
- **Three modes**: Visual (click to edit), Source (edit raw HTML), Preview (the page's own controls work normally)

### Agent editing (agentic direct file edit)
- **Edit with Agent**: write a one-line instruction, optionally attach a screenshot, and let the local Agent (codex / cbc) read, modify, and save the file directly
- **Selection context**: when you select an element, its name, DOM path, and a text excerpt are passed to the Agent as the "only target to modify", preventing it from editing the wrong section
- **Automatic backup & restore**: the original file is backed up before each call (`<name>.hve-backup-<timestamp>.html`); restore with one click if the result is unsatisfactory
- **Isolation & timeout**: the Agent runs in a clean temporary working directory to avoid being hijacked by `AGENTS.md` / `.ccg` workflows in the workspace; it runs asynchronously without freezing the UI and is terminated automatically after a timeout

### Files & configuration
- **File operations**: open local `.html` / `.htm`, save (overwrite), save as / export
- **Agent settings**: discover and register local Agents, choose the current one
- **Cross-environment**: runs both as a Tauri desktop app and in a plain browser (file operations degrade to file picker / download / localStorage config)

> The settings page has **only the Agent tab**. The old "Models" and "External Calls" tabs were removed with the agentic architecture; HTTP model-call code was cleaned up on both frontend and backend. The `models` / `proto` fields in the config file remain only for backward compatibility and are no longer used at runtime.

---

## Requirements

- Node.js >= 18
- Rust toolchain (cargo / rustc) for the Tauri desktop build
- macOS / Windows / Linux (Tauri is cross-platform)

---

## Installation & Run

```bash
# Install dependencies
npm install

# Development mode (hot reload)
npm run tauri dev

# Frontend only (file operations degrade to browser picker/download)
npm run dev

# Build the desktop app
npm run tauri build
```

Build output (macOS example):

```
src-tauri/target/release/bundle/
├── dmg/      HTML可视化编辑器_1.0.0_aarch64.dmg
└── macos/    HTML可视化编辑器.app
```

> On macOS an unsigned app may be blocked by Gatekeeper. Right-click "Open", or run:
> `codesign --force --deep --sign - "src-tauri/target/release/bundle/macos/HTML可视化编辑器.app"`

---

## Workflow

1. Launch the app, click "Editor" in the left rail, then "Open" to load a local HTML file.
2. In Visual mode, click an element on the page; the right panel shows the target card and the manual editing / Agent editing areas.
3. Manual edits: edit text (whole-block replacement), replace an image (local image inlined as base64), insert / delete blocks; undo or redo if unsatisfied.
4. Agent edits: write a one-line instruction in the right-panel "Edit with Agent" area, optionally attach a screenshot, and click "Edit with Agent". The program hands the current file plus the selection context to the local Agent; when it finishes, the file is reloaded and the view returns to the Visual editor. Use "Restore to before Agent edit" to roll back from the backup.
5. Click "Save" to overwrite the original file, or "Save As / Export" to create a new one.

---

## How it works

### Source-level precise patch
Traditional rich-text editors serialize the DOM into HTML, losing original formatting. This project performs precise string replacement on the source:

1. **Node location**: describe an element with a `tag:nth-of-type(n)` path (independent of id / class), verifying the full parent chain to avoid matching a sibling branch.
2. **Tag-stack scan**: scan the source string to obtain the target node's `start/end` offsets.
3. **String replacement**: replace only the target range; all other bytes stay untouched.

For dynamically rendered nodes that cannot be located in the source, a "freeze script" replays the change after the page loads. On save, inserts already written to the source are filtered out of the freeze script to avoid inserting the same content twice.

### Agent direct edit and rewrite protection
`agent_edit_file` starts the local Agent in a clean temporary directory, passes the target file by absolute path along with the selection context and a strong "modify only this one place" constraint. This prevents the Agent from loading `AGENTS.md` / `.ccg` tasks in the file's directory and rewriting the whole page (a past incident turned a local edit into a full-page infographic conversion). The file is backed up before the call and compared byte-for-byte afterward; if nothing actually changed, the call is treated as a failure. The command runs asynchronously with a 600-second timeout, so the UI never freezes.

---

## Project structure

```
.
├── index.html
├── package.json
├── vite.config.ts
├── tsconfig.json
├── src/
│   ├── main.tsx                # React entry
│   ├── App.tsx                 # Main UI: editor (visual/source/preview) + settings + context panel
│   ├── styles.css
│   └── lib/
│       ├── tauriApi.ts         # File/config wrappers + Agent invocation
│       ├── htmlPatch.ts        # Source-level patch, path location, freeze script, lightbox
│       ├── config/             # Config manager (Agent registry / current Agent)
│       ├── editCore/           # Editing core (FieldTarget / validation / rollback)
│       ├── iframeBridge.ts     # In-iframe click bridge
│       ├── agentEdit.ts        # Legacy plan flow (tests only)
│       ├── adapters/           # Legacy CLI plan extraction (tests only)
│       ├── blockRenderer.ts    # Legacy block sanitizer (tests only)
│       ├── providers/          # Legacy model presets (no references, kept for compatibility)
│       └── imageResize.ts      # Image resizing utility
├── src-tauri/
│   ├── src/main.rs             # Rust entry + 5 custom commands
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── capabilities/default.json
├── scripts/
│   ├── test_full_e2e.mjs       # Real-file end-to-end tests (55 checks)
│   ├── test_*.mjs              # Module tests
│   └── TEST_REPORT.md          # Fix & verification log
└── docs/
    ├── 技术方案.md              # Technical design (Chinese)
    ├── GUI使用说明.md           # GUI user guide (Chinese)
    └── (legacy GUI prototype is a local file, not version-controlled)
```

---

## Tauri commands

| Command | Purpose |
|---|---|
| `read_config` / `write_config` | Read/write `config.json` in the app config directory |
| `discover_agents` | Scan PATH for codex / cbc / codebuddy / workbuddy / dsh / cloud-cli |
| `agent_edit_file` | Backup + clean cwd + selection context, invoke the local Agent directly, async + timeout + content verification |
| `restore_agent_backup` | Restore the file from its backup |

---

## Testing

```bash
npm run test:all          # 8 module test suites in sequence
node scripts/test_full_e2e.mjs   # Real HTML end-to-end tests (55 checks)
npx tsc --noEmit          # Type check
cargo check --manifest-path src-tauri/Cargo.toml   # Rust compile check
```

See [`scripts/TEST_REPORT.md`](./scripts/TEST_REPORT.md) for the detailed fix and verification log (Chinese).

---

## Documentation

- [README_EN.md](./README_EN.md) (this file)
- [README_CN.md](./README_CN.md) (Chinese)
- [Technical design](./docs/技术方案.md) (Chinese)
- [GUI user guide](./docs/GUI使用说明.md) (Chinese)
- The legacy GUI prototype is a local file excluded from version control and is not provided in this repository.
