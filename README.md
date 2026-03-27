# VS_pkvsconf

![Project icon](icon.png)

[🇫🇷 FR](README.md) · [🇬🇧 EN](README_en.md)

✨ Extension VS Code simple pour booster l'Explorer et la navigation du projet.

## ✅ Fonctionnalites

- 🧭 Reveal in Finder (macOS)
- 📦 Taille du dossier racine
- 🖼️ Project Icon
- 🐙 Open GitHub Repository
- 🏷️ Tags d'extensions
- 👁️ Preview de la page en cours
- 🎨 Couleur de title bar par workspace
- 🔐 Detection des secrets exposes
- 🛡️ Blocage de commit avec secrets
- 🔗 Agent Skills : symlink `.agent` vers le dossier central `-agent`
## 🧠 Utilisation

- Reveal in Finder : bouton en haut du panneau Explorer (macOS).
- Taille du dossier racine : indicateur en status bar, clic pour rafraichir.
- Project Icon : place un `icon.*` a la racine pour afficher l'icone.
- Open GitHub Repository : bouton dans Source Control.
- Tags d'extensions : clic droit sur une extension pour taguer.
- Preview page : bouton en status bar, support PHP avec serveur auto.
- Title bar : couleur auto par workspace, bouton pour regenerer.
- Secrets : scan workspace + blocage de commit si secrets staged.
- Agent Skills : cree un lien symbolique `.agent` vers le dossier central `-agent`.

## ⚙️ Reglages

Aucun reglage dedie. Les couleurs de la status bar utilisent :

- `pkvsconf.rootSizeStatusBarItem.background`
- `pkvsconf.rootSizeStatusBarItem.foreground`

## 🧾 Commandes

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
- Agent Skills

## 📦 Build & Package

```bash
cd extension
npm run release
```

## 🧪 Installation (Antigravity)

- Palette de commandes : "Extensions: Install from VSIX..."
- Selectionner `release/vs-pkvsconf-1.40.0.vsix`
- Recharger la fenetre

## 🧾 Release Notes

### 1.40.0

- 🔗 Le bouton `Agent Skills` cree maintenant un symlink `.agent` vers `-agent`.
- 🔁 Si `.agent` existe deja mais pointe ailleurs, le lien est remplace automatiquement.
- ✅ Si `.agent` pointe deja vers `-agent`, un message indique qu'il est deja present.

### 1.39

- 📝 Alignement du `extension/README.md` sur le meme contenu que le README GitHub.

### 1.38

- 📝 Ajout d'un `extension/README.md` pour alimenter correctement l'overview du Visual Studio Marketplace.
- 🔗 Ajout du lien vers la page publisher du store dans le README.

### 1.37

- 🔗 Le bouton devient `Agent Skills` et cree maintenant le symlink `.agent` vers le dossier central `-agent`.
- 🛡️ `.agent/` et les patterns de secrets locaux sont ignores par Git pour eviter les commits accidentels.
- 🔗 Ajout d'un lien direct vers la page Marketplace dans le README.

### 0.3.37

- 🔗 Ajout de la commande pour creer un symlink `.skills` vers un dossier central.

### 0.3.36

- 📝 Passage de la licence en MIT.

### 0.3.35

- 🚨 Warning automatique des qu'un fichier avec secret est stage. Plus besoin d'utiliser une commande speciale, le warning s'affiche automatiquement.

### 0.3.34

- 🛡️ Nouvelle fonctionnalite : Blocage de commit avec secrets. Scanne les fichiers staged avant commit et bloque si des secrets sont detectes. Options : voir les secrets, ajouter au .gitignore, ou forcer le commit.
- 🔐 Ajout de la detection des secrets exposes dans le workspace avec indicateur dans la status bar.

### 0.3.30

- 🎨 Ajout d'un bouton dans la status bar pour changer la couleur de la title bar (en plus de la commande palette).

### 0.3.29

- 👁️ Ajout de la fonctionnalité Preview de la page en cours. Bouton dans la status bar pour ouvrir une preview dans un nouvel onglet. Support PHP avec serveur automatique.

### 0.3.23

- 🏷️ Nouvel icone d'onglet \"PK Extensions\".

### 0.3.22

- 🏷️ Nom de l'extension conserve en \"VS_pkvsconf\" et onglet affiche \"PK Extensions\".

### 0.3.21

- 🏷️ Renommage de l'onglet en \"PK Extensions\".

### 0.3.20

- 🧩 Nouveau pictogramme d'onglet (style extension/puzzle) et nom \"PK Extension\".

### 0.3.19

- 🏷️ Mise a jour de l'icone de l'onglet Extensions (tag plus explicite).

### 0.3.6

- 🏷️ La vue "Extension Tags" est maintenant dans l'Explorer (plus stable que l'onglet Extensions).

### 0.3.5

- 🏷️ Ajustement du container de vue "Extension Tags" pour l'onglet Extensions.

### 0.3.4

- 🏷️ Fix de l'enregistrement de la vue "Extension Tags" dans l'onglet Extensions.

### 0.3.3

- 🏷️ Ajout du tagging d'extensions avec vue "Extension Tags" (sections par tag, collapse/expand).
- 🐙 Open GitHub Repository supporte le multi-repo (selection si plusieurs repos).

## 🔗 Liens

- EN README : README_en.md
- VS Code Marketplace : https://marketplace.visualstudio.com/items?itemName=Cmondary.vs-pkvsconf
- Publisher Marketplace : https://marketplace.visualstudio.com/publishers/Cmondary
