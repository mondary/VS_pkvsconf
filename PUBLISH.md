# Guide de publication vers VS Code Marketplace

## Méthode 1 : Publication manuelle (plus simple)

### Étape 1 : Installer vsce globalement

```bash
npm install -g @vscode/vsce
```

### Étape 2 : Se connecter

```bash
cd extension
vsce login
```

Cela va ouvrir votre navigateur pour vous connecter avec votre compte Microsoft/GitHub (celui utilisé pour le marketplace).

### Étape 3 : Publier

```bash
cd extension
npm run build
vsce publish
```

C'est tout ! L'extension sera publiée automatiquement.

---

## Méthode 2 : Avec Personal Access Token (pour GitHub Actions)

### Obtenir un PAT

1. **Aller sur le site du marketplace** :
   - Ouvrir : https://marketplace.visualstudio.com/manage
   - Se connecter avec votre compte (Microsoft/GitHub)

2. **Créer un token** :
   - En haut à droite, cliquer sur votre nom/avatar
   - Cliquer sur "Personal Access Tokens" ou "Manage"
   - Si vous ne voyez pas cette option, chercher un lien "Create Token" ou "Generate Token"
   - Donner un nom au token (ex: "GitHub Actions")
   - Cliquer sur "Create" ou "Generate"
   - **IMPORTANT** : Copier le token immédiatement (il ne sera affiché qu'une fois)

3. **Si vous ne trouvez pas l'option** :
   - Certains comptes peuvent avoir une interface différente
   - Chercher dans les paramètres de votre profil
   - Ou utiliser la méthode 1 (vsce login) qui est plus simple

### Ajouter le token dans GitHub

1. Aller dans votre repo GitHub → **Settings** → **Secrets and variables** → **Actions**
2. Cliquer sur **New repository secret**
3. Nom : `VSCE_PAT`
4. Valeur : coller le token
5. Cliquer sur **Add secret**

### Publier via GitHub Actions

Créer une release GitHub ou utiliser "Run workflow" dans l'onglet Actions.

---

## Alternative : Publication manuelle depuis votre machine

Si vous préférez publier manuellement depuis votre ordinateur :

```bash
cd extension
npm run build
vsce publish
```

Ou avec un token :

```bash
cd extension
npm run build
vsce publish -p VOTRE_TOKEN_ICI
```

---

## Vérifier la publication

Après publication, votre extension sera disponible sur :
https://marketplace.visualstudio.com/items?itemName=Cmondary.vs-pkvsconf

(Remplacez `Cmondary.vs-pkvsconf` par votre publisher.name si différent)
