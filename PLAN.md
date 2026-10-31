# PLAN — Scan : négatifs et émulation de pellicule, 100 % local

## Choix de pile

- **Vite + TypeScript + React 19.** Choix de React plutôt que Svelte : l'outillage de test
  (Vitest, Playwright) et l'écosystème de composants accessibles sont les plus éprouvés, et
  l'état global reste petit grâce à `zustand`.
- **WebGL2** pour l'aperçu, shaders GLSL dans `src/gl/shaders/*.glsl` (importés en `?raw`).
- **Web Workers** (module) pour le décodage, l'analyse, les miniatures et l'export.
- **IndexedDB** via `idb-keyval` : réglages par image, présets personnels, miniatures,
  file d'export et sorties intermédiaires (pour la reprise).
- **fflate** pour le ZIP en flux (et la compression Deflate des TIFF).
- **Vitest** (logique pure) et **Playwright** (parcours complet dans Chromium).

## Architecture

```
            ┌──────────── thread principal (React) ────────────┐
 fichiers → │ import/collect  →  store (zustand)  →  UI         │
            │        │                │      ↑                   │
            │        ▼                ▼      │                   │
            │   WorkerPool ──► decode.worker (miniature, proxy,  │
            │        │          analyse auto, aperçu Float16)    │
            │        │                                           │
            │        └─────► export.worker (pleine résolution,   │
            │                 pipeline CPU, encodage JPEG/PNG/TIFF)
            │   gl/Renderer (WebGL2, 3 passes) ◄── texture aperçu│
            │   export/queue (2–4 travaux, IDB) → zip (fflate)   │
            └───────────────────────────────────────────────────┘
```

### Un seul modèle de rendu, deux implémentations

Le rendu est décrit par des **paramètres compilés** (`core/compile.ts`) à partir des
réglages : uniformes d'inversion, matrice couleur, LUT de tonalité 1D (1024 entrées par
canal), paramètres de grain, halo, vignettage, netteté. Ces paramètres sont consommés :

- par le **shader** (aperçu temps réel) ;
- par le **pipeline CPU** `core/pipeline.ts` (export pleine résolution dans un worker,
  miniatures, et tests unitaires). Les deux suivent les mêmes formules, le même bruit
  (hash entier identique en GLSL et en TS) et la même carte de halo calculée en basse
  résolution, ce qui garantit que l'export ressemble à l'aperçu.

Ordre du pipeline (par pixel) :

1. Décodage de la courbe de transfert d'entrée (sRGB, gamma ou linéaire) et matrice
   vers sRGB linéaire (profil ICC matrice/TRC lu dans le TIFF ou le JPEG).
2. **Inversion** (négatif) dans le domaine des densités :
   `p = log10(base / v)` par canal, où `base` est le masque orange mesuré sur le bord
   non exposé ; normalisation par canal `n = (p − pmin) / (pmax − pmin)` (supprime le
   masque et équilibre les canaux), puis gamma par canal (balance auto sur les tons
   moyens). Le N&B passe par la luminance. Les valeurs auto sont stockées dans les
   réglages : l'utilisateur peut les relancer ou les ajuster.
3. Balance des blancs (température / teinte → multiplicateurs) et exposition, en linéaire.
4. Matrice couleur du préset (mélange de canaux), puis passage en espace perceptif.
5. LUT de tonalité : contraste (S autour de 0,5), courbes du préset, courbes utilisateur
   RVB et par canal, relèvement des noirs.
6. Virage partagé (ombres / hautes lumières), saturation et vibrance.
7. Halo : hautes lumières floutées (carte basse résolution) ajoutées avec une teinte rouge.
8. Netteté (masque flou sur la luminance), vignettage, grain dépendant de la luminance.

### Mémoire et réactivité (40 Mpx)

- Le thread principal ne reçoit jamais l'image pleine résolution : il reçoit une
  **texture d'aperçu** (côté long ≤ 2560 px, Float16) et un **proxy** (≤ 640 px) pour
  le rendu pendant le glissement d'un curseur.
- Pendant un réglage, le canvas est rendu à 50 % depuis le proxy ; au relâchement, en
  pleine définition d'affichage.
- L'export pleine résolution se fait ligne par ligne (fenêtre glissante de 3 lignes pour
  la netteté) ; mémoire ≈ image source en Uint16 + tampon de sortie.
- La file d'export pondère les travaux par mégapixels (budget mémoire) : 4 travaux pour
  des JPEG moyens, 1–2 pour des scans de 40 Mpx.
- Miniatures : grille virtualisée ; seules les vignettes visibles ont une URL d'objet,
  les autres restent dans IndexedDB.

### Couleur

- Espace de travail : sRGB linéaire, sortie sRGB.
- JPEG : `createImageBitmap(..., {colorSpaceConversion: 'default'})` convertit le profil
  embarqué vers sRGB.
- TIFF : lecteur ICC matrice/TRC (Adobe RGB, ProPhoto, Gamma 1.0…), conversion vers sRGB
  linéaire. Les profils LUT (A2B) ne sont pas gérés : avertissement, traité comme sRGB.
- Affichage : canvas WebGL `drawingBufferColorSpace = 'srgb'`, le navigateur gère la
  conversion vers l'écran (pas de double conversion, pas de troncature en 8 bits avant
  le shader).
- Export : JPEG/PNG en sRGB ; TIFF 16 bits avec un profil ICC sRGB embarqué.

## Structure des dossiers

```
src/
  core/          logique pure (testée) : tiff/, icc, couleur, analyse, courbes,
                 réglages, présets, compilation, pipeline CPU, bruit, historique, nommage
  presets/       présets JSON (un fichier par film)
  gl/            Renderer WebGL2 + shaders/*.glsl
  workers/       decode.worker, export.worker, pool + RPC
  import/        collecte des fichiers (glisser-déposer récursif, sélecteurs)
  export/        file de traitement, ZIP en flux, encodeurs
  state/         store zustand + persistance IndexedDB
  ui/            composants React
tests/           tests Vitest
e2e/             tests Playwright
fixtures/        images de test générées (scripts/gen-fixtures.ts)
```

## Découpage des tâches

### Phase 1 — cœur
- [x] Décodeur TIFF (8/16 bits, RGB/gris, bandes/tuiles, none/LZW/Deflate/PackBits,
      prédicteur), encodeur TIFF 16 bits, lecteur ICC.
- [x] Import : glisser-déposer fichiers et dossiers récursifs, `<input multiple>`,
      `<input webkitdirectory>`, `showDirectoryPicker` si disponible.
- [x] Grille de miniatures virtualisée, décodage en worker.
- [x] Inversion couleur / N&B, détection auto du type d'image, auto-balance, auto-tonalité.
- [x] 10 présets JSON descriptifs.
- [x] Intensité du préset, avant/après maintenu (bouton ou touche `B`).
- [x] Aperçu WebGL2, basse résolution pendant le réglage.
- [x] Tests unitaires.

### Phase 2 — réglages avancés
- [x] Panneaux repliables (fermés par défaut) avec valeur par défaut et réinitialisation.
- [x] Courbes RVB et par canal (éditeur à points, clavier compris).
- [x] Sauvegarde par image (IndexedDB), présets personnels.
- [x] Export / import des réglages en JSON.
- [x] Annuler / rétablir (`Ctrl+Z`, `Ctrl+Maj+Z`).

### Phase 3 — lot et export
- [x] Copier / coller des réglages, préset sur une sélection.
- [x] File d'export : 2 à 4 travaux, progression, annulation, reprise après rechargement.
- [x] ZIP en flux avec modèle de nommage `{nom}_{film}_{n}`.
- [x] Export unitaire JPEG, PNG, TIFF 16 bits.

## Questions ouvertes (hypothèses retenues en attendant une réponse)

1. **Fichiers après rechargement.** Un navigateur ne peut pas relire un fichier sans
   l'accord de l'utilisateur. Hypothèse : avec Chromium, les `FileSystemFileHandle` sont
   conservés et un clic « Rétablir l'accès » suffit ; ailleurs, l'image est marquée
   « à réimporter » et ses réglages sont retrouvés à la réimportation (empreinte
   nom + taille + date).
2. **Reprise d'un ZIP interrompu.** Un ZIP partiellement écrit n'est pas réutilisable.
   Hypothèse : chaque sortie terminée est conservée dans IndexedDB jusqu'à la
   finalisation ; à la reprise, le ZIP est régénéré avec les sorties déjà calculées puis
   les restantes.
3. **Courbe des scans 16 bits sans profil.** Hypothèse : encodés en sRGB. Un réglage
   « courbe d'entrée » (sRGB / linéaire / gamma 2,2) permet de corriger.
4. **« Pleine résolution au relâchement ».** Interprétation : pleine définition
   d'affichage (jusqu'à 2560 px de côté long) ; la vraie pleine résolution n'est
   calculée qu'à l'export.
5. **Halo et netteté** sont rendus à l'échelle de l'affichage dans l'aperçu ; le grain
   est proportionnel au cadre (comme sur film), donc identique à l'export.
6. **LUT .cube** : non incluse dans cette version (les présets sont paramétriques).
   Ajout prévu : texture 3D en GLSL et interpolation trilinéaire côté CPU.
7. **RAW** : hors périmètre (prévu via un décodeur WASM type LibRaw).
