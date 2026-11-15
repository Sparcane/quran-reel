# Sources des données

## Texte coranique — Tanzil

Le texte arabe est le **Tanzil Quran Text (Uthmani, version 1.1)**, copié sans
aucune modification de caractère.

- Source : <https://tanzil.net/download/>
- Métadonnées (noms, nombre de versets, lieu de révélation) :
  <https://tanzil.net/res/text/metadata/quran-data.xml>
- Licence : Creative Commons Attribution 3.0 — <https://tanzil.net/docs/tanzil_license>
- Récupéré le 2026-11-15 par `npm run build:data`.

Le bloc de copyright présent dans le fichier source est conservé tel quel.
L'attribution est affichée dans l'application (page « À propos ») avec un lien
vers tanzil.net, comme la licence l'exige.

`data/source/quran-uthmani.txt` n'est pas versionné (1,4 Mo, retéléchargé au
besoin) ; `quran-data.xml` l'est, et `packages/core/src/surah-meta.ts` est généré
depuis lui par `npm run generate:catalog`.
