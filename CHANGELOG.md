# Changelog

Toutes les modifications notables de **VS_pkvsconf** sont documentées ici.

---

## TODO — Roadmap

Statut : `2.2026.16`

### Feature 1 — Add to .gitignore ✅
- [x] Commande « ⛔ Ajouter au .gitignore » au clic droit explorer
- [x] Dédoublonnage + création si absent
- [x] Déclaration correcte dans le manifest

### Feature 2 — Décorations gitignore ✅
- [x] Badge `⛔` sur fichiers/dossiers ignorés dans l'explorateur
- [x] Auto-refresh quand `.gitignore` change
- [x] Badge emoji (`⛔`) pour visibilité maximale

### Explorer UX ✅
- [x] Boutons Launchpad déplacés vers la vue Project Icon
- [x] Icônes codicons sur toutes les vues
- [x] Champ de recherche dans la sidebar Launchpad

### Favoris Launchpad ✅
- [x] Champ `favorite` sur les projets Launchpad
- [x] Tri favoris d'abord (sidebar, panel, QuickPick)
- [x] Badge ★ doré sur les cards favorites (sidebar + panel)
- [x] Commande « Launchpad: Basculer le statut favori » (palette + context menu)
- [x] Raccourci `Cmd/Ctrl+Alt+Shift+S`
- [x] Option « ★ Favoris » dans le sélecteur de tri
- [x] Handler `toggleFavorite` dans le panel webview

### Notes ✅
- [x] Auto-save renforcé (blur + indicateur "✓ Sauvé")
- [x] Mode aperçu avec checkboxes interactives
- [x] Accordéon "Notes masquées" pour les items cochés

### Title bar ✅
- [x] Unicité de couleur entre instances VS Code (globalState)

### Reveal in Finder ✅
- [x] Fix : ouvre le bon dossier sur macOS (cp.exec au lieu de openExternal)

### Documentation & tooling
- [x] Skill versionning fusionnée avec skill README (FR + EN)
- [x] CHANGELOG.md au format TODO + Releases
- [x] README.md et README_en.md synchronisés, changelog externalisé
- [x] VERSION à jour

---

## Releases

### [2.2026.14] - 2026-07-18
#### Fixed
- ⛔ Ajout au `.gitignore` : les fichiers sont désormais ajoutés sans slash final, afin que Git les ignore correctement.
- 🔄 Décorations Git : le badge des fichiers ignorés est rafraîchi immédiatement après l'ajout.

### [2.2026.12] - 2026-07-17
#### Fixed
- 🐛 Reveal in Finder : ouvre maintenant le bon dossier sur macOS (cp.exec au lieu de openExternal)
#### Added
- 🔍 Champ de recherche dans la sidebar Launchpad Projets
- 👁️ Mode aperçu dans les notes avec checkboxes interactives
- 📋 Accordéon "Notes masquées" pour les items cochés (- [x])
- 💾 Auto-save renforcé : sauvegarde immédiate au blur + indicateur "✓ Sauvé"
- 🎨 Title bar : unicité de couleur entre instances VS Code (globalState)
#### Changed
- 📝 Mise à jour VERSION, CHANGELOG, README, README_en

### [2.2026.11] - 2026-07-17
#### Changed
- 🎨 Icônes des vues ajoutées (codicons natifs) : `$(rocket)` Launchpad, `$(note)` Notes, `$(history)` Agent History, `$(tag)` PK Extensions, `$(symbol-color)` Project Icon.

### [2.2026.10] - 2026-07-17
#### Changed
- 🗂️ Ordre explicite des vues : `Launchpad Projets` avant `Project Icon` dans l'Explorer.

### [2.2026.7] - 2026-07-17
#### Changed
- 🚀 Boutons Launchpad (plein écran + ajout projet) déplacés de l'Explorer vers la vue Project Icon

### [2.2026.6] - 2026-07-17
#### Changed
- ⛔ Badge gitignore passé de `⊘` (symbole math, trop petit) à `⛔` (emoji, plus visible, rouge natif)

### [2.2026.5] - 2026-07-17
#### Changed
- 🎨 Couleur du badge gitignore changée pour `editorWarning.foreground` (ambre)

### [2.2026.4] - 2026-07-17
#### Added
- 👁️ Décorations gitignore dans l'explorateur : badge `⛔` à droite des fichiers/dossiers ignorés par Git
- 🔄 Auto-refresh des décorations quand `.gitignore` change ou quand des fichiers sont créés/supprimés

### [2.2026.3] - 2026-07-17
#### Fixed
- 🐛 Déclaration manquante de la commande `pkvsconf.addToGitignore` dans le tableau `commands` du manifest

### [2.2026.2] - 2026-07-17
#### Fixed
- 🐛 Suppression du `when` clause trop restrictif sur le menu contextuel gitignore

### [2.2026.1] - 2026-07-17
#### Added
- ⛔ « Ajouter au .gitignore » dans le clic droit de l'explorateur (fichiers + dossiers)
- 🔄 Dédoublonnage automatique, création du `.gitignore` si absent
#### Changed
- 📝 Passage au format de version `<major>.<year>.<release>`
- 📝 Skill de versionning rendue générique (suppression des références PKotty)

### [2.16.0] - 2026-07-17
#### Fixed
- 🐛 Le bouton Term crée un nouvel onglet dans la fenêtre principale au lieu du panneau droit

### [2.13.0]
#### Added
- 📋 Kanban TUI persistant par workspace
- 🤖 Session `tmux` OpenCode par carte active

### [2.1.0]
#### Added
- 🚀 Launchpad projets : vue explorateur + statut bar + raccourci

### [2.0.0]
#### Added
- 🗂️ Deux sections : projets en cours et projets du launchpad

### [1.40.0]
#### Added
- 🔗 Bouton `Agent Skills` créant un symlink `.agent`

### [0.3.34]
#### Added
- 🛡️ Blocage de commit avec secrets
- 🔐 Détection des secrets exposés

### [0.3.29]
#### Added
- 👁️ Preview de la page en cours (support PHP)

### [0.3.3]
#### Added
- 🏷️ Tagging d'extensions
- 🐙 Open GitHub Repository (multi-repo)

### [0.10]
#### Added
- Initial project scaffold
