# VS_pkvsconf

![Project icon](icon.png)

[🇫🇷 FR](README.md) · [🇬🇧 EN](README_en.md)

✨ Extension VS Code simple pour booster l'Explorer et la navigation du projet.

## ✅ Fonctionnalités

- 🧭 Reveal in Finder (macOS)
- 📦 Taille du dossier racine
- 🖼️ Project Icon
- 🐙 Open GitHub Repository
- 🏷️ Tags d'extensions
- 👁️ Preview de la page en cours
- 🎨 Couleur de title bar par workspace
- 🔐 Détection des secrets exposés
- 🛡️ Blocage de commit avec secrets
- 🚀 Launchpad projets (plein écran + liste + bascule rapide)
- 📋 Kanban TUI avec cartes Backlog, In Progress, In Review et Done
- 🔗 Agent Skills : symlink `.agent` vers le dossier central `-agent`
- ⛔ Ajouter au .gitignore (clic droit dans l'explorateur)
- 👁️ Décorations gitignore : badge `⛔` sur les fichiers/dossiers ignorés dans l'explorateur
- 🎯 Icônes codicons sur toutes les vues (fusée, note, historique, tag, palette)
- 🔍 Champ de recherche dans la sidebar Launchpad
- 👁️ Mode aperçu notes avec checkboxes + accordéon "Notes masquées"
- 💾 Auto-save renforcé (blur + indicateur)
- 🎨 Title bar : unicité de couleur entre instances VS Code

## 🧠 Utilisation

- Reveal in Finder : bouton en haut du panneau Explorer (macOS).
- Taille du dossier racine : indicateur en status bar, clic pour rafraîchir.
- Project Icon : place un `icon.*` à la racine pour afficher l'icône.
- Open GitHub Repository : bouton dans Source Control.
- Tags d'extensions : clic droit sur une extension pour taguer.
- Preview page : bouton en status bar, support PHP avec serveur auto.
- Title bar : couleur auto par workspace, bouton pour régénérer.
- Secrets : scan workspace + blocage de commit si secrets staged.
- Agent Skills : crée un lien symbolique `.agent` vers le dossier central `-agent`.
- Launchpad : boutons dans la vue Project Icon pour ouvrir le plein écran et ajouter le projet courant. Raccourci `Cmd/Ctrl+Alt+L` pour la liste.
- Ordre des vues : `Launchpad Projets` apparaît avant `Project Icon` dans l'Explorer.
- Kanban : bouton `Kanban` dans la barre de status. Chaque carte peut lancer ou reprendre une session OpenCode isolée dans `tmux`.
- ⛔ Add to .gitignore : clic droit sur un fichier/dossier dans l'explorateur → ajout automatique au `.gitignore` (création si absent, dédoublonnage).
- 👁️ Décorations gitignore : les fichiers et dossiers ignorés par Git affichent un badge `⛔` dans l'explorateur. Mise à jour automatique quand `.gitignore` change.

## ⚙️ Réglages

Le Kanban utilise :

- `pkvsconf.kanban.agentCommand` : commande d'agent, par défaut `opencode --prompt {prompt}`.
- `pkvsconf.kanban.tmuxCommand` : exécutable tmux, par défaut `tmux`.

Les couleurs de la status bar utilisent :

- `pkvsconf.rootSizeStatusBarItem.background`
- `pkvsconf.rootSizeStatusBarItem.foreground`

## 🧾 Commandes

- Reveal Active File in Finder
- Refresh Root Folder Size
- Open GitHub Repository
- Catégorie (Add Tag)
- Rechercher des extensions
- Régénérer la couleur de la title bar
- Preview de la page en cours
- Afficher les secrets exposés
- Rescanner les secrets
- Commit (vérification secrets)
- Agent Skills
- Ouvrir le Kanban des agents
- ⛔ Ajouter au .gitignore

## 📦 Build & Package

```bash
cd src
npx tsc --outDir dist
npx @vscode/vsce package --allow-missing-repository
```

## 🧪 Installation

- Palette de commandes : "Extensions: Install from VSIX..."
- Sélectionner le fichier `.vsix` dans `release/`
- Ou en CLI : `code --install-extension release/vs-pkvsconf-2.2026.14.vsix --force`
- Recharger la fenêtre

## 📋 Changelog

Voir [CHANGELOG.md](CHANGELOG.md) pour l'historique complet.

## 🔗 Liens

- EN README : README_en.md
- VS Code Marketplace : https://marketplace.visualstudio.com/items?itemName=Cmondary.vs-pkvsconf
- Publisher Marketplace : https://marketplace.visualstudio.com/publishers/Cmondary
