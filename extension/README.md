# VS_pkvsconf

![Extension icon](icon.png)

✨ Extension VS Code simple, claire et sympa pour booster ton Explorer.

Extension VS Code qui ajoute un bouton dans la barre de titre de l'Explorer pour reveler le fichier actif dans Finder (macOS), un indicateur de taille du dossier racine, et un panneau "Project Icon" dans l'Explorer.

## ✅ Fonctionnalites

- 🧭 Reveal in Finder (macOS)

  Bouton dans la barre de titre de l'Explorer (en haut du panneau fichiers). Ouvre le fichier actif ou le dossier du workspace dans Finder.

- 📦 Taille du dossier racine

  Indicateur en bas (status bar) avec rafraichissement automatique et clic pour forcer la mise a jour.

- 🖼️ Project Icon

  Place un fichier `icon.*` (ex: `icon.png`) a la racine du workspace. L'icone s'affiche dans l'Explorer; sinon un message d'aide est affiche.

- 🐙 Open GitHub Repository

  Bouton dans l'onglet Source Control. Ouvre le repo GitHub du projet; si plusieurs repos sont detectes, un choix est propose.

- 🏷️ Tags d'extensions

  Clic droit sur une extension pour "Add Tag" ou "Create Tag". Une vue "Extension Tags" apparait dans l'Explorer avec des sections par tag (collapse/expand).

## 📁 Arborescence

- `extension/` : code de l'extension, build, scripts
- `openspec/` : specs OpenSpec
- `release/` : packages .vsix generes

## 🛠️ Build, package et installation (.vsix)

Depuis les sources (build + package) :

```bash
cd extension && npm run release
```

Le .vsix est genere dans `release/` automatiquement (ex: `vs-pkvsconf-0.3.6.vsix`).

Depuis un .vsix (installation) :

- Commande palette (macOS: Cmd+Shift+P, Windows/Linux: Ctrl+Shift+P): "Extensions: Install from VSIX..."
- Selectionner le fichier `vs-pkvsconf-0.3.6.vsix` dans `release/`
- Recharger la fenetre

## 🧾 Release Notes

### 0.3.6

- 🏷️ La vue "Extension Tags" est maintenant dans l'Explorer (plus stable que l'onglet Extensions).

### 0.3.5

- 🏷️ Ajustement du container de vue "Extension Tags" pour l'onglet Extensions.

### 0.3.4

- 🏷️ Fix de l'enregistrement de la vue "Extension Tags" dans l'onglet Extensions.

### 0.3.3

- 🏷️ Ajout du tagging d'extensions avec vue "Extension Tags" (sections par tag, collapse/expand).
- 🐙 Open GitHub Repository supporte le multi-repo (selection si plusieurs repos).
