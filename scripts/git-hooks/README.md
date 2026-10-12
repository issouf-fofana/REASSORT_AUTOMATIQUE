# Hook de versioning automatique

`pre-commit` incrémente automatiquement le patch (`X.Y.Z` → `X.Y.(Z+1)`) du fichier `VERSION` à la
racine du dépôt, à chaque commit. Le major/minor (`X.Y`) se changent toujours à la main en éditant
`VERSION` directement.

## Installation (une fois par clone du dépôt)

```bash
git config core.hooksPath scripts/git-hooks
```

Les hooks dans `.git/hooks/` ne sont jamais versionnés par Git — cette commande pointe Git vers ce
dossier versionné à la place, pour que le hook soit actif sur n'importe quel clone sans étape
manuelle supplémentaire à chaque fois.
