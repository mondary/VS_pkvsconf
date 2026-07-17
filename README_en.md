# VS_pkvsconf

![Project icon](icon.png)

[🇬🇧 EN](README_en.md) · [🇫🇷 FR](README.md)

✨ Simple VS Code extension to boost Explorer and project navigation.

## ✅ Features

- 🧭 Reveal in Finder (macOS)
- 📦 Root folder size
- 🖼️ Project Icon
- 🐙 Open GitHub Repository
- 🏷️ Extension tags
- 👁️ Active page preview
- 🎨 Workspace title bar color
- 🔐 Exposed secrets detection
- 🛡️ Commit blocking with secrets
- 🚀 Projects Launchpad (fullscreen + list + quick switch)
- 📋 Kanban TUI with Backlog, In Progress, In Review and Done cards
- 🔗 Agent Skills: `.agent` symlink to the central `-agent` folder
- ⛔ Add to .gitignore (right-click in explorer)
- 👁️ Gitignore decorations: `⛔` badge on ignored files/folders in explorer
- 🎯 Native codicon icons on all views (rocket, note, history, tag, palette)
- 🔍 Search field in Launchpad sidebar
- 👁️ Notes preview mode with checkboxes + "Hidden notes" accordion
- 💾 Enhanced auto-save (blur + save indicator)
- 🎨 Title bar: cross-instance color uniqueness (globalState)

## 🧠 Usage

- Reveal in Finder: button at the top of Explorer (macOS).
- Root folder size: status bar indicator, click to refresh.
- Project Icon: place an `icon.*` at workspace root.
- Open GitHub Repository: button in Source Control.
- Extension tags: right-click an extension to tag it.
- Page preview: status bar button, PHP supported with auto server.
- Title bar: auto color per workspace, button to regenerate.
- Secrets: workspace scan + block commit if staged secrets.
- Agent Skills: creates a `.agent` symlink to the central `-agent` folder.
- Launchpad: buttons in the Project Icon view to open fullscreen and add the current project. Shortcut `Cmd/Ctrl+Alt+L` for the list.
- View order: `Launchpad Projets` appears before `Project Icon` in Explorer.
- Kanban: `Kanban` status bar button. Each card can start or resume an isolated OpenCode session in `tmux`.
- ⛔ Add to .gitignore: right-click a file/folder in explorer → automatically added to `.gitignore` (created if missing, deduplicated).
- 👁️ Gitignore decorations: files and folders ignored by Git show a `⛔` badge in explorer. Auto-refresh when `.gitignore` changes.

## ⚙️ Settings

Kanban settings:

- `pkvsconf.kanban.agentCommand`: agent command, defaults to `opencode --prompt {prompt}`.
- `pkvsconf.kanban.tmuxCommand`: tmux executable, defaults to `tmux`.

Status bar colors use:

- `pkvsconf.rootSizeStatusBarItem.background`
- `pkvsconf.rootSizeStatusBarItem.foreground`

## 🧾 Commands

- Reveal Active File in Finder
- Refresh Root Folder Size
- Open GitHub Repository
- Category (Add Tag)
- Search extensions
- Regenerate title bar color
- Preview active page
- Show exposed secrets
- Rescan secrets
- Commit (secrets check)
- Agent Skills
- Open the agent Kanban
- ⛔ Add to .gitignore

## 📦 Build & Package

```bash
cd src
npx tsc --outDir dist
npx @vscode/vsce package --allow-missing-repository
```

## 🧪 Installation

- Command Palette: "Extensions: Install from VSIX..."
- Select the `.vsix` file in `release/`
- Or via CLI: `code --install-extension release/vs-pkvsconf-2.2026.12.vsix --force`
- Reload window

## 📋 Changelog

See [CHANGELOG.md](CHANGELOG.md) for full history.

## 🔗 Links

- FR README : README.md
- VS Code Marketplace : https://marketplace.visualstudio.com/items?itemName=Cmondary.vs-pkvsconf
- Publisher Marketplace : https://marketplace.visualstudio.com/publishers/Cmondary
