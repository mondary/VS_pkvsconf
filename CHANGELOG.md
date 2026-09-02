# Changelog

Toutes les modifications notables de **VS_pkvsconf** sont documentées ici.

---

## TODO — Roadmap

Statut : `2.2026.35`

### Feature 1 — Add to .gitignore ✅
- [x] Commande « ⛔ Ajouter au .gitignore » au clic droit explorer
- [x] Dédoublonnage + création si absent
- [x] Déclaration correcte dans le manifest

### Feature 2 — Décorations gitignore ✅
- [x] Badge `⛔` sur fichiers/dossiers ignorés dans l'explorateur
- [x] Auto-refresh quand `.gitignore` change
- [x] Badge emoji (`⛔`) pour visibilité maximale

### Feature 3 — Tailles fichiers/dossiers lisibles ✅
- [x] Vue arborescente `Tailles du projet` intégrée au panneau Explorer
- [x] Taille complète alignée à droite du nom via `TreeItem.description`
- [x] Dossiers dépliables et fichiers ouvrables au clic
- [x] Tooltip avec chemin et taille précise au survol
- [x] Dossiers calculés en async avec cache
- [x] Setting `pkvsconf.explorer.showSizes` (default `true`)
- [x] Bouton `$(refresh) Rafraîchir les tailles` dans la toolbar de l'explorateur
- [x] Suppression de l'ancienne vue dédiée `pkvsconfSizeExplorerView` + container activity bar `pkvsconfSizeContainer` (redondants avec l'explorateur natif)

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

### Sessions agents par projet ✅
- [x] Registre local `.vscode/pkvsconf-agent-sessions.json`
- [x] Résumés append-only dans `.vscode/pkvsconf-agent-resumes.md`
- [x] Proposition de reprise de la dernière session à l'ouverture
- [x] Bouton `$(history) Sessions` dans la status bar
- [x] QuickPick pour reprendre, archiver ou consulter les résumés
- [x] Édition directe du JSON et suppression d'une session depuis la liste

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

### [2.2026.35] - 2026-09-02
#### Added
- 🔗 Le bouton `Agent Skills` crée maintenant aussi le symlink `.inspi` → `~/Documents/GitHub/-inspi` (librairie d'inspiration design, fichiers HTML). Dossier cible créé au besoin, `.inspi` ajouté au `.gitignore`, statut final détaillé pour les deux liens.

### [2.2026.34] - 2026-08-30
#### Fixed
- ▶️ Session « en cours » fiable : le plugin TUI écrit maintenant un fichier par session vivante (`current-sessions/<id>.json`, heartbeat 30 s) et **le supprime à la fermeture** ; le picker considère une session vivante seulement si son fichier a moins de 90 s. L'heuristique de repli passe de 5 min à 2 min. Fini les spinners fantômes après fermeture d'onglet.

### [2.2026.33] - 2026-08-30
#### Added
- ▶️ Plugin TUI OpenCode `~/.config/opencode/plugins/current-session.js` : publie l'ID de la session ouverte dans `~/.local/share/opencode/current-session.json` (heartbeat 60 s). Le picker Sessions marque ensuite la vraie session en cours (détection exacte par ID, au lieu de la seule heuristique des 5 min).
- Astuce CLI : `opencode session list | sed -n 2p` affiche l'ID de la session la plus récente.

### [2.2026.32] - 2026-08-30
#### Changed
- 🔴 Fraîcheur : les sessions de plus de 30 j passent au rouge (au lieu du blanc).
- ▶️ Session en cours : icône `$(sync~spin)` tournante + mention « en cours » pour toute session active il y a moins de 5 min (ex. celle ouverte dans le terminal).

### [2.2026.31] - 2026-08-30
#### Changed
- 🎨 Picker Sessions : lisibilité — pastille de fraîcheur colorée (🟢 <24h · 🟡 <7j · 🟠 <30j · ⚪ avant), dates relatives en français, modèle + tokens dans la colonne de droite.

### [2.2026.30] - 2026-08-30
#### Fixed
- 📜 Sessions : détection multi-dossiers (workspaces multi-root / .code-workspace), fallback `/usr/bin/sqlite3` si absent du PATH de l'extension host, et diagnostic visible dans la ligne « Aucune session détectée » (dossiers scannés, base trouvée, erreur éventuelle).

### [2.2026.29] - 2026-08-30
#### Added
- ⚙️ Menu « Fonctionnalités : activer / désactiver » (`pkvsconf.toggleFeatures`, palette de commandes) : toggle des 17 features — boutons status bar, vues latérales, boutons Explorer/SCM, menus contextuels, décorations gitignore et tailles. État persisté (globalState), appliqué à chaud sans reload via context keys + guards.
- 📜 Sessions : ligne « Aucune session détectée » dans le picker quand aucune session OpenCode/Codex n'existe pour le dossier (retour visuel immédiat).

### [2.2026.28] - 2026-08-30
#### Added
- 🧠 Historique réel des sessions agents : le picker `$(history) Sessions` détecte maintenant automatiquement les sessions **OpenCode** (base SQLite `~/.local/share/opencode/opencode.db`) et **Codex** (`~/.codex/sessions/`) du projet courant — titre, modèle, tokens, date — filtrées strictement sur le dossier du workspace. Reprise en un clic (`opencode -s <id>` / `codex resume <id>`) ou copie de la commande. Titres codex extraits du premier message utilisateur réel. Zéro dépendance (CLI `sqlite3` macOS).

### [2.2026.27] - 2026-08-27
#### Fixed
- 🔵 Badges de taille dans l'Explorateur natif : fini le clignotement — calcul des dossiers désormais 100 % async (plus de `du -sk` synchrone bloquant), cache TTL 60 s, et les événements fichier ne vidangent plus les badges (refresh manuel inchangé).

### [2.2026.26] - 2026-08-03
#### Added
- 🟢 Bouton `$(play) Server` dans la status bar + commande `pkvsconf.launchServer` : démarre un serveur PHP local (détection `local-router.php` / `router.php` / `index.php`) et ouvre le navigateur sur le fichier PHP actif.
- 🐘 Preview PHP : ouverture directe dans le navigateur via serveur local quand on prévisualise un `.php`.
#### Fixed
- 🎨 Volet Project Icon : fond noir en mode sombre corrigé — le webview utilise désormais `--vscode-sideBar-background` comme tous les autres panneaux (au lieu de `background: transparent`).
- 🚀 Launchpad : fermeture automatique du panneau quand on lance un projet dans une nouvelle fenêtre, pour retrouver le workspace en revenant sur la fenêtre courante.
- 🐘 Serveurs PHP : clé de cache désormais `docRoot::router`, servers persistants non nettoyés, et ports occupés skippés proprement.

### [2.2026.25] - 2026-07-24
#### Fixed
- Dossiers sans taille : `provideFileDecoration` rendu synchrone avec placeholder `…` pendant le calcul async.
- Les dossiers lourds comme `src` affichent maintenant leur taille après calcul.

### [2.2026.24] - 2026-07-24
#### Fixed
- Calcul des dossiers en arrière-plan afin qu'un dossier lourd ne bloque plus les décorations des autres lignes.
- Affichage exact en octets pour les fichiers inférieurs à 1 Ko.

### [2.2026.23] - 2026-07-24
#### Added
- Affichage simultané des tailles complètes dans l'Explorer natif et dans la vue détaillée.
- Patch local de la validation VS Code des badges longs, avec sauvegarde des fichiers originaux et checksum synchronisé.

### [2.2026.22] - 2026-07-24
#### Changed
- Remplacement des badges natifs limités et illisibles par une vue dédiée `Tailles du projet`.
- Affichage des tailles complètes à droite des noms, avec navigation dans les dossiers et ouverture des fichiers.

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
