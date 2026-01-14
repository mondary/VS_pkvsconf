# VS_pkvsconf

✨ Extension VS Code simple, claire et sympa pour booster ton Explorer.

Extension VS Code qui ajoute un bouton dans la barre de titre de l'Explorer pour reveler le fichier actif dans Finder (macOS), un indicateur de taille du dossier racine, et un panneau "Project Icon" dans l'Explorer.

## 🧭 Project Icon

Place un fichier `icon.*` (ex: `icon.png`) a la racine du workspace pour afficher l'icone dans l'Explorer. Sans icone, un message d'aide est affiche.

## ✅ Fonctionnalites

- 🧭 Reveal in Finder (macOS) via bouton dans la barre de titre de l'Explorer.
- 📦 Taille du dossier racine en status bar avec rafraichissement manuel/auto.
- 🖼️ Project Icon dans l'Explorer base sur `icon.*` a la racine.

## 📁 Arborescence

- `extension/` : code de l'extension, build, scripts
- `openspec/` : specs OpenSpec
- `release/` : packages .vsix generes

## 🛠️ Build et package (une seule commande)

```bash
cd extension && npm run release
```

Le .vsix est genere dans `release/` automatiquement (ex: `vs-pkvsconf-0.3.2.vsix`).

## 📦 Installation du .vsix (instance ouverte)

- Commande palette: "Extensions: Install from VSIX..."
- Selectionner le fichier `vs-pkvsconf-0.3.2.vsix` dans `release/`
- Recharger la fenetre
