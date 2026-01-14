# PKrevealinfinder

Extension VS Code qui ajoute un bouton dans la barre de titre de l'Explorer pour reveler le fichier actif dans Finder (macOS), et un panneau "Project Icon" dans l'Explorer.

## Project Icon

Place un fichier `icon.*` (ex: `icon.png`) a la racine du workspace pour afficher l'icone dans l'Explorer. Sans icone, un message d'aide est affiche.

## Arborescence

- `extension/` : code de l'extension, build, scripts
- `openspec/` : specs OpenSpec
- `release/` : packages .vsix generes

## Build et package (une seule commande)

```bash
cd extension && npm run release
```

Le .vsix est genere dans `release/` automatiquement (ex: `PKrevealinfinder-0.3.1.vsix`).

## Installation du .vsix (instance ouverte)

- Commande palette: "Extensions: Install from VSIX..."
- Selectionner le fichier `PKrevealinfinder-0.3.1.vsix` dans `release/`
- Recharger la fenetre
