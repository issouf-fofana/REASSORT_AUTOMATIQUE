Tu es un Senior Product Designer + Senior Frontend Engineer spécialisé dans les interfaces mobiles modernes.

Je veux refondre l'interface complète de mon projet en utilisant comme référence visuelle l'image fournie.

IMPORTANT :
L'image de référence sert à définir le LANGAGE VISUEL, le DESIGN SYSTEM, les proportions, les espacements, les formes, les ombres, les boutons, les cartes, les champs et la hiérarchie visuelle.

Ne copie pas littéralement les écrans de l'image.
Ne reproduis pas son contenu ou sa structure fonctionnelle.
Adapte uniquement son STYLE VISUEL à mon application et à ses fonctionnalités existantes.

==================================================
1. OBJECTIF GLOBAL
==================================================

Transforme l'ensemble de mon application afin d'obtenir une interface :

- minimaliste
- premium
- moderne
- élégante
- très lisible
- principalement monochrome
- orientée mobile
- très aérée
- avec une hiérarchie visuelle claire
- avec très peu de décoration inutile
- avec des composants arrondis
- avec des ombres extrêmement subtiles
- avec des boutons noirs très visibles
- avec des icônes line-art fines
- avec des surfaces gris très clair
- avec beaucoup d'espace négatif

L'interface doit donner une impression de :
"premium minimal mobile app"

Elle doit ressembler à une application moderne conçue par une équipe produit professionnelle, et non à un template générique.

==================================================
2. DIRECTION ARTISTIQUE
==================================================

Utilise une esthétique monochrome.

Palette principale :

- Background principal : #F7F7F7
- Surface / cards : #FFFFFF
- Surface secondaire : #F1F1F1
- Gris très clair : #EAEAEA
- Bordure : #E2E2E2
- Texte principal : #111111
- Texte secondaire : #6F6F6F
- Texte désactivé : #A5A5A5
- Noir CTA : #111111
- Blanc : #FFFFFF

Évite les couleurs fortes par défaut.

Ne pas utiliser :
- gradients colorés
- néons
- ombres fortes
- effets glassmorphism excessifs
- bordures épaisses
- couleurs saturées
- éléments visuellement bruyants

Si une couleur métier est absolument nécessaire, utilise-la uniquement comme accent très discret.

Le noir et les gris doivent dominer l'expérience.

==================================================
3. TYPOGRAPHIE
==================================================

Utilise une police moderne et très lisible.

Priorité :

1. Inter
2. SF Pro / system-ui
3. Geist
4. équivalent sans-serif moderne

Hiérarchie :

Large title :
font-size: 28-32px
font-weight: 600-700
line-height: 1.15

Section title :
font-size: 20-24px
font-weight: 600

Card title :
font-size: 16-18px
font-weight: 600

Body :
font-size: 14-16px
font-weight: 400
line-height: 1.5

Caption :
font-size: 12-13px
color: #777777

Les titres doivent être courts et visuellement forts.

Évite les textes trop gras partout.

==================================================
4. ESPACEMENT
==================================================

Utilise un système d'espacement cohérent basé sur 4px.

Exemple :

4px
8px
12px
16px
20px
24px
32px
40px
48px

Utilise principalement :

- padding horizontal mobile : 20px
- padding vertical : 20-24px
- gap entre sections : 24-32px
- gap entre éléments liés : 8-16px

L'interface doit respirer.

Ne jamais remplir artificiellement l'écran.

Le whitespace est une partie importante du design.

==================================================
5. BORDER RADIUS
==================================================

Utilise des coins généreusement arrondis.

Petits éléments :
8-10px

Inputs :
12-14px

Cards :
16-20px

Grandes sections / bottom sheets :
24-28px

Boutons principaux :
12-16px

Les coins doivent donner une sensation douce et moderne.

Évite les rectangles parfaitement carrés sauf lorsque cela est fonctionnellement nécessaire.

==================================================
6. OMBRES
==================================================

Les ombres doivent être presque imperceptibles.

Exemple :

box-shadow:
0 4px 20px rgba(0,0,0,0.05);

Pour les éléments flottants :

box-shadow:
0 8px 30px rgba(0,0,0,0.08);

Ne jamais utiliser :
- grosse ombre noire
- shadow très foncée
- effet 3D
- néon

L'élévation doit être suggérée, pas dessinée.

==================================================
7. BOUTONS
==================================================

Les boutons principaux doivent être noirs avec texte blanc.

Exemple :

background: #111111
color: #FFFFFF
border-radius: 14px
height: 48-52px

Style :

[     Get started     ]

Le bouton doit être suffisamment grand pour être facilement utilisé au doigt.

Bouton principal :
- pleine largeur lorsque pertinent
- hauteur 48-52px
- radius 14px
- font-weight 500-600
- aucune décoration inutile

Bouton secondaire :
- fond #F1F1F1
- texte #111111

Bouton tertiaire :
- transparent
- texte #555555

Ajouter des états :

hover
active
pressed
disabled
loading

Mais garder les transitions très discrètes.

==================================================
8. INPUTS / FORMULAIRES
==================================================

Les champs doivent être extrêmement propres.

Style :

background: #FFFFFF
border: 1px solid #E2E2E2
border-radius: 12-14px
height: 48-52px

Label :
petit
semi-bold
#333333

Placeholder :
#A0A0A0

Focus :
bordure #111111

Évite les bordures épaisses.

Les formulaires doivent paraître simples et premium.

==================================================
9. CARDS
==================================================

Les cards sont un élément central du design.

Utiliser :

background: #FFFFFF
border-radius: 18px
padding: 16-20px

Optionnel :
border: 1px solid #EEEEEE

Shadow :
très subtile.

Une card peut contenir :

- icône
- image
- titre
- description
- metadata
- bouton
- statut
- action secondaire

Les cards doivent être visuellement simples.

Évite de mettre trop d'informations dans une seule card.

==================================================
10. ICÔNES
==================================================

Utiliser uniquement des icônes minimalistes de type line-art.

Style recommandé :

- stroke fin
- monochrome
- aucune icône 3D
- aucune icône multicolore
- aucune illustration complexe

Utiliser une librairie cohérente comme Lucide Icons si disponible.

Les icônes doivent généralement être :

18px
20px
24px

Ne mélange pas plusieurs styles d'icônes.

==================================================
11. NAVIGATION MOBILE
==================================================

Créer une navigation mobile très simple.

Bottom navigation :

- fond blanc
- légère séparation supérieure
- 4 ou 5 éléments maximum
- icône + label si nécessaire
- état actif en noir
- état inactif en gris

La navigation doit rester discrète.

Ne pas utiliser de gros blocs colorés.

==================================================
12. HEADER
==================================================

Les headers doivent être minimalistes.

Exemple :

←                    ⋯

ou

←    Page title       🔍

Utiliser beaucoup d'espace.

Éviter les headers surchargés.

Le titre doit être clairement identifiable.

==================================================
13. MODALS / BOTTOM SHEETS
==================================================

Les modals doivent suivre le style de la référence.

Utiliser :

- overlay gris/noir transparent
- background blanc
- radius supérieur 24-28px
- padding 20-24px
- shadow très légère

Le contenu doit être hiérarchisé.

Ajouter un bouton de fermeture discret.

Pour les actions importantes, utiliser le bouton noir principal.

==================================================
14. EMPTY STATES
==================================================

Les empty states doivent rester très minimalistes.

Exemple :

       [ line icon ]

       Aucun élément

       Une courte description expliquant
       quoi faire ensuite.

       [ Commencer ]

Utiliser des illustrations très simples ou des icônes line-art.

Pas d'illustrations complexes ou colorées.

==================================================
15. LOADING STATES
==================================================

Créer des skeleton loaders gris très clair.

Exemple :

#EEEEEE

avec des formes arrondies.

Éviter les spinners agressifs.

Les skeletons doivent respecter exactement les dimensions des vrais composants.

==================================================
16. MICRO-INTERACTIONS
==================================================

Ajouter des animations très subtiles.

Durée :
150-250ms

Utiliser :

ease-out

Exemples :

- bouton qui change légèrement de couleur au press
- card qui monte de 1-2px
- modal qui apparaît doucement
- bottom sheet qui slide-up
- navigation active qui transitionne
- skeleton loading subtil

Ne jamais utiliser d'animations extravagantes.

L'animation doit renforcer l'impression premium.

==================================================
17. RESPONSIVE DESIGN
==================================================

L'application doit être pensée MOBILE FIRST.

Priorité :

375px
390px
412px
430px

Puis adapter pour :

768px
1024px
1440px+

Sur mobile :

- contenu pleine largeur
- padding horizontal 16-20px
- boutons facilement accessibles
- zones tactiles minimum 44px
- bottom navigation fixe si nécessaire

Sur desktop :

Ne pas simplement étirer l'interface mobile.

Créer une version desktop cohérente avec :
- max-width
- contenu centré
- colonnes si nécessaire
- sidebar lorsque pertinent
- cards plus larges

==================================================
18. IMAGES
==================================================

Les images doivent avoir des coins arrondis.

Exemples :

border-radius: 16px

Utiliser object-fit: cover lorsque nécessaire.

Les images doivent être intégrées dans les cards sans casser le rythme visuel.

Éviter les images avec des cadres lourds.

==================================================
19. GRILLE / LAYOUT
==================================================

Utiliser une structure très propre.

Exemple mobile :

Header
↓
Hero / titre
↓
Section
↓
Cards
↓
Section suivante
↓
Bottom navigation

Ne jamais avoir plusieurs éléments concurrents au même niveau visuel.

Chaque écran doit avoir :

1. une action principale
2. une hiérarchie claire
3. une lecture verticale naturelle

==================================================
20. ACCESSIBILITÉ
==================================================

Le design doit rester accessible.

Respecter :

- contraste suffisant
- taille de texte lisible
- touch targets minimum 44x44px
- labels explicites
- états focus visibles
- navigation clavier sur desktop
- support prefers-reduced-motion

Ne pas sacrifier l'accessibilité pour l'esthétique.

==================================================
21. COMPOSANTS À CRÉER
==================================================

Créer ou refactoriser les composants suivants :

- Button
- IconButton
- Input
- SearchInput
- Textarea
- Select
- Checkbox
- Radio
- Switch
- Card
- Avatar
- Badge
- Chip
- Modal
- BottomSheet
- Toast
- Alert
- Skeleton
- Divider
- Header
- BottomNavigation
- TabBar
- ListItem
- EmptyState
- LoadingState
- Dropdown
- Tooltip
- Pagination si nécessaire

Tous ces composants doivent appartenir au même design system.

==================================================
22. DESIGN TOKENS
==================================================

Créer des variables globales pour éviter les valeurs arbitraires.

Exemple :

--color-background: #F7F7F7;
--color-surface: #FFFFFF;
--color-surface-secondary: #F1F1F1;
--color-border: #E2E2E2;

--color-text-primary: #111111;
--color-text-secondary: #6F6F6F;
--color-text-muted: #A5A5A5;

--color-primary: #111111;
--color-primary-foreground: #FFFFFF;

--radius-sm: 8px;
--radius-md: 12px;
--radius-lg: 18px;
--radius-xl: 24px;

--spacing-1: 4px;
--spacing-2: 8px;
--spacing-3: 12px;
--spacing-4: 16px;
--spacing-5: 20px;
--spacing-6: 24px;
--spacing-8: 32px;
--spacing-10: 40px;
--spacing-12: 48px;

--shadow-sm: 0 2px 10px rgba(0,0,0,.04);
--shadow-md: 0 8px 30px rgba(0,0,0,.06);

Tous les composants doivent utiliser ces tokens.

Ne pas hardcoder des dizaines de valeurs différentes.

==================================================
23. ARCHITECTURE VISUELLE
==================================================

Chaque écran doit suivre cette logique :

1. Background clair
2. Header minimal
3. Titre / contexte
4. Contenu principal
5. Cards ou sections
6. Action principale
7. Navigation

Créer une hiérarchie visuelle forte uniquement avec :

- taille
- poids typographique
- espace
- contraste
- position
- radius
- surface

Ne pas utiliser des couleurs pour créer artificiellement la hiérarchie.

==================================================
24. RÈGLE IMPORTANTE SUR LE DESIGN
==================================================

Quand tu hésites entre :

A. ajouter un élément
B. supprimer l'élément

Privilégie la simplicité.

Quand tu hésites entre :

A. plusieurs couleurs
B. noir + gris

Privilégie noir + gris.

Quand tu hésites entre :

A. une interface dense
B. une interface respirante

Privilégie l'interface respirante.

Quand tu hésites entre :

A. décoration
B. fonctionnalité

Privilégie la fonctionnalité.

Le design doit paraître volontairement simple.

==================================================
25. ADAPTATION À MON PROJET
==================================================

Ne supprime aucune fonctionnalité existante.

Commence par analyser :

- toutes les pages
- tous les composants
- toutes les routes
- tous les flows utilisateurs
- les formulaires
- les états loading
- les états empty
- les erreurs
- les modals
- les navigations
- les actions principales

Ensuite applique le nouveau design system à l'ensemble du projet.

Ne change pas la logique métier sauf si cela est nécessaire pour corriger un problème évident d'UX.

==================================================
26. MÉTHODE DE TRAVAIL
==================================================

Étape 1 :
Analyse l'application existante.

Étape 2 :
Identifie tous les composants réutilisables.

Étape 3 :
Crée le nouveau design system.

Étape 4 :
Crée les design tokens.

Étape 5 :
Refactorise les composants globaux.

Étape 6 :
Refais les écrans principaux.

Étape 7 :
Refais les écrans secondaires.

Étape 8 :
Ajoute les états loading / empty / error.

Étape 9 :
Vérifie le responsive.

Étape 10 :
Vérifie l'accessibilité.

Étape 11 :
Supprime les styles incohérents et les anciennes couleurs.

Étape 12 :
Effectue une dernière passe UX/UI pour assurer la cohérence entre tous les écrans.

==================================================
27. QUALITÉ VISUELLE
==================================================

À la fin, inspecte chaque écran comme le ferait un Senior Product Designer.

Vérifie :

- alignements
- spacing
- tailles
- contrastes
- radius
- ombres
- cohérence des boutons
- cohérence des inputs
- cohérence des icons
- cohérence de la navigation
- responsive
- hiérarchie visuelle

Aucun écran ne doit sembler appartenir à une autre application.

Tout doit avoir le même langage visuel.

==================================================
28. RÉSULTAT ATTENDU
==================================================

Le résultat final doit évoquer :

Minimal
Premium
Clean
Modern
Mobile-first
Monochrome
Soft
Elegant
Professional
Highly usable

Le résultat doit être proche de l'esprit visuel de l'image de référence :

- fond gris/blanc très clair
- cards blanches
- gros border-radius
- ombres très légères
- boutons noirs
- textes noirs/gris
- icônes line-art
- beaucoup de whitespace
- interface très propre
- composants arrondis
- hiérarchie extrêmement claire

IMPORTANT :
Ne transforme pas simplement les couleurs de l'application actuelle.

Recompose réellement l'interface afin qu'elle adopte ce langage visuel.

Conserve les fonctionnalités et les données existantes, mais améliore fortement la présentation, la hiérarchie et l'expérience utilisateur.

Avant de modifier du code, inspecte l'architecture existante et identifie les composants qui peuvent être réutilisés.

Ensuite implémente progressivement le nouveau design system dans tout le projet.