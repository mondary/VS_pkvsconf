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
- 🔗 .skills symlink to a central folder

## 🧠 Usage

- Reveal in Finder: button at the top of Explorer (macOS).
- Root folder size: status bar indicator, click to refresh.
- Project Icon: place an `icon.*` at workspace root.
- Open GitHub Repository: button in Source Control.
- Extension tags: right-click an extension to tag it.
- Page preview: status bar button, PHP supported with auto server.
- Title bar: auto color per workspace, button to regenerate.
- Secrets: workspace scan + block commit if staged secrets.
- Skills: create a `.skills` symlink to a central folder.

## ⚙️ Settings

No dedicated settings. Status bar colors use:

- `pkvsconf.rootSizeStatusBarItem.background`
- `pkvsconf.rootSizeStatusBarItem.foreground`

## 🧾 Commands

- Reveal Active File in Finder
- Refresh Root Folder Size
- Open GitHub Repository
- Catégorie (Add Tag)
- Rechercher des extensions
- Regenerer la couleur de la title bar
- Preview de la page en cours
- Afficher les secrets exposes
- Rescanner les secrets
- Commit (verification secrets)
- Create Skills Symlink

## 📦 Build & Package

```bash
cd extension
npm run release
```

## 🧪 Install (Antigravity)

- Command Palette: "Extensions: Install from VSIX..."
- Select `release/vs-pkvsconf-0.3.37.vsix`
- Reload window

## 🧾 Changelog

### 0.3.37

- 🔗 Added command to create a `.skills` symlink to a central folder.

### 0.3.36

- 📝 Switched license to MIT.

### 0.3.35

- 🚨 Automatic warning when a staged file contains secrets.

### 0.3.34

- 🛡️ Commit blocking if secrets are found in staged files.
- 🔐 Added exposed secrets detection with status bar indicator.

### 0.3.30

- 🎨 Added a status bar button to regenerate the title bar color.

### 0.3.29

- 👁️ Added active page preview with PHP auto server.

### 0.3.23

- 🏷️ New "PK Extensions" tab icon.

### 0.3.22

- 🏷️ Extension name kept as "VS_pkvsconf" and tab shows "PK Extensions".

### 0.3.21

- 🏷️ Renamed tab to "PK Extensions".

### 0.3.20

- 🧩 New tab pictogram (extension/puzzle) and name "PK Extension".

### 0.3.19

- 🏷️ Updated Extensions tab icon (more explicit tag).

### 0.3.6

- 🏷️ "Extension Tags" view moved into Explorer (more stable).

### 0.3.5

- 🏷️ Adjusted "Extension Tags" view container for Extensions tab.

### 0.3.4

- 🏷️ Fix for registering the "Extension Tags" view in Extensions tab.

### 0.3.3

- 🏷️ Added extension tagging with "Extension Tags" view.
- 🐙 Open GitHub Repository supports multi-repo selection.

## 🔗 Links

- FR README : README.md
