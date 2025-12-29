# PKrevealinfinder

Extension VS Code qui ajoute un bouton dans la barre de titre de l'Explorer pour reveler le fichier actif dans Finder (macOS).

## Arborescence

- `extension/` : code de l'extension, build, scripts
- `openspec/` : specs OpenSpec
- `releases/` : packages .vsix generes

## Build et package (une seule commande)

```bash
cd extension && npm run release
```

Le .vsix est genere dans `releases/`.

## Installation du .vsix (instance ouverte)

- Commande palette: "Extensions: Install from VSIX..."
- Selectionner le fichier dans `releases/`
- Recharger la fenetre
