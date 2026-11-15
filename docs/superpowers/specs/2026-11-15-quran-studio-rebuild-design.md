# Quran Studio — reconstruction multi-plateforme

**Date** : 15 novembre 2026
**Statut** : proposé — en attente d'approbation
**Portée** : application web + Android + Windows

---

## 1. Intention

L'application existante (`recitation-smoky.vercel.app`) fait bien trois choses : elle présente
les 114 sourates, elle laisse choisir des versets, et elle propose un studio de mise en forme
vidéo. Elle échoue sur tout le reste : le service de génération est en panne permanente (503),
la page de résultat affiche « Vidéo prête » pour des jobs inexistants, rien n'est indexé par
les moteurs de recherche, et l'interface n'existe qu'en français.

On la reconstruit pour en faire un **produit public gratuit**, publié sur le web, sur Google
Play et sur Windows, qui **fonctionne sans serveur** : l'utilisateur choisit des versets, met
en forme sa vidéo, et l'appareil produit le fichier MP4 lui-même.

Le succès, c'est : un utilisateur ouvre l'app, choisit la sourate 36, sélectionne cinq versets,
choisit un récitateur, lance le rendu, et récupère sur son téléphone une vidéo verticale de 45
secondes avec l'arabe, la traduction et l'audio synchronisé — **sans connexion**, et sans
qu'aucune de ses données ne quitte l'appareil.

**Projet neuf, pas une migration.** Le dossier de travail est vide ; il n'existe pas de code
source de l'application d'origine à reprendre. Les défauts corrigés listés au §7 proviennent
d'un audit boîte noire mené le 12 novembre 2026 sur le site en production.

---

## 2. Objectifs, non-objectifs, anti-objectifs

**Objectifs**
- Rendu vidéo 100 % local, sur les trois plateformes, sans backend.
- Fidélité du texte coranique : Tanzil, verbatim, attribution respectée.
- Synchronisation exacte arabe ↔ audio, verset par verset.
- Fonctionnement hors-ligne après téléchargement d'une sourate.
- Produit publiable : signature, politique de confidentialité, fiches de store.
- Accessibilité AA et pages web indexables.

**Non-objectifs (v1)**
- Comptes utilisateurs, paiement, synchronisation cloud.
- Rendu 4K.
- Rendu côté serveur, quel qu'il soit.
- Réseau social intégré, commentaires, likes.
- Import de récitation personnelle (reporté en v1.1, voir §11).
- Recherche de fonds Pexels/Pixabay en ligne (reportée en v1.1, voir §6.3).

**Anti-objectifs** — ce qui rendrait le projet raté même s'il « marche »
- Une app qui dépend d'un serveur pour produire une vidéo.
- Une vidéo produite en silence avec un mauvais audio, ou un fichier corrompu.
- Un texte coranique modifié, incomplet, ou sans attribution.
- Une app publiée qu'on ne peut plus corriger.

---

## 3. Contraintes

| Contrainte | Conséquence |
|---|---|
| Machine de développement : Windows, Node 26, npm 11, Git | Pas de JDK, pas d'Android SDK, pas de Rust/MSVC → **à installer** pour Android ; Electron évite Rust |
| Aucun backend autorisé | Tout le rendu, le stockage et l'état vivent dans le navigateur/WebView |
| **Durée maximale d'une vidéo : 15 minutes** | 27 000 images à 30 fps : le MP4 ne peut pas vivre en mémoire, l'encodage écrit en continu sur le disque (§6.3) |
| Sources audio : EveryAyah | MP3 **par verset** (un fichier = un verset) → pas de timestamps à deviner |
| Texte : Tanzil | copie verbatim autorisée, modification interdite, attribution + lien obligatoires |
| Fonds : locaux + CC0 embarqués | pas de clé API dans le client, donc pas de recherche en ligne sans serveur |
| Budget | zéro coût d'infrastructure récurrent. Hébergement web statique gratuit |
| Public | comptes développeur Google Play et Microsoft Store à la charge du commanditaire |

---

## 4. Approches considérées

**A. Rendu sur l'appareil** — canvas + WebCodecs, MP4 assemblé localement.
Zéro serveur, zéro coût par vidéo, hors-ligne, aucune donnée envoyée. Lent sur vieux matériel.
**Retenue.**

**B. Serveur de rendu** — file d'attente, authentification, workers, stockage.
Rapide et 4K, mais coût récurrent réel, complexité RGPD, et c'est précisément l'architecture
qui a échoué. **Écartée** : elle reproduit le point de panne unique.

**C. Hybride** — local par défaut, serveur en option pour 4K et longues sourates.
Meilleur résultat final, mais double le travail avant la première publication. **Écartée
pour la v1**, conservée comme évolution : l'interface `VideoRenderer` (§6.3) est le point
d'entrée unique qui permettra de la brancher sans réécrire l'app.

---

## 5. Décisions prises avec le commanditaire

1. Produit **public**, gratuit, sans comptes en v1.
2. Rendu **sur l'appareil** (approche A).
3. Un **socle unique** + deux emballages natifs, pas trois bases de code.
4. Sources **autorisant la publication** : Tanzil (texte), EveryAyah (audio), CC0/Pexels/Pixabay (fonds embarqués).
5. Périmètre fonctionnel de la v1 validé (voir §7).
6. **15 minutes maximum** par vidéo.
7. Fonds v1 : dégradés animés + import local + petite banque embarquée. Recherche en ligne reportée.
8. Import de récitation personnelle reporté en v1.1.

---

## 6. Architecture

### 6.1 Découpage du dépôt

Monorepo npm workspaces (npm est déjà présent ; pas de pnpm à installer).

```
quran-reel/
  apps/web/            Next.js, App Router, output: 'export'  (site + base des emballages)
  apps/desktop/        Electron : fenêtre, protocole app://, mises à jour
  apps/android/        Capacitor (généré, versionné)
  packages/core/       types, accès données, construction de la timeline
  packages/render/     moteur de rendu (le cœur)
  scripts/             pipeline de données (Tanzil + liste des récitateurs)
  data/source/         fichiers téléchargés une fois, versionnés, avec leur licence
  docs/
```

**Pourquoi Next avec `output: 'export'`** : le web a besoin de pages rendues côté serveur pour
être indexable (défaut n°3 de l'audit). L'export statique produit 114 pages HTML pré-rendues
**et** un dossier `out/` directement consommable par Capacitor et Electron. Un seul artefact,
trois cibles.

### 6.2 Données

Pipeline `scripts/build-data.ts`, exécuté à la main et versionné :

- **Tanzil** : texte uthmani + métadonnées, téléchargés une fois → `data/source/`.
  Fichier `ATTRIBUTION.md` à côté, avec l'URL et la date de récupération.
- **Traductions** : une par langue visée (fr, en). *Chaque traduction a sa propre licence :
  à vérifier individuellement avant intégration* (voir §9).
- **Récitateurs** : `reciters.json` curé à la main — `{ id, nom: {fr,en,ar}, dossierEveryAyah, bitrate }`.

Sorties publiques :

| Fichier | Contenu | Taille visée |
|---|---|---|
| `public/data/surahs-index.json` | 114 entrées : numéro, noms, nb de versets, lieu | ~15 Ko |
| `public/data/surahs/{001..114}.json` | versets + arabe + traductions | 30–120 Ko |
| `public/data/reciters.json` | ~40 récitateurs | ~8 Ko |

**Audio non empaqueté** : URL déterministe
`https://everyayah.com/data/{dossier}/{SSS}{AAA}.mp3` (ex. `036001.mp3`). C'est justement
parce que la source est découpée par verset qu'on obtient une synchronisation exacte sans
fichier de timings : la durée d'un verset est celle de son MP3.

**En-têtes vérifiés le 15/11/2026** sur `everyayah.com` :

```
HTTP/1.1 200 OK            Content-Type: audio/mpeg
Access-Control-Allow-Origin: *
Accept-Ranges: bytes
Cache-Control: max-age=25600000     (≈ 296 jours)
Server: BunnyCDN
```

Le `*` en CORS autorise le téléchargement et le décodage directement dans le client, sans
proxy — y compris depuis l'origine `app://` d'Electron et la WebView Android, qui envoient
`Origin: null`. `Accept-Ranges` permet la lecture en flux et la reprise d'un téléchargement.
C'est ce qui rend l'approche A viable sans serveur.

Un script de vérification (`npm run verify:data`) contrôle après génération :
6236 versets au total, 114 sourates, aucune chaîne vide, aucun verset sans MP3 correspondant
(échantillonnage HEAD sur 1 verset par sourate et par récitateur).

### 6.3 Moteur de rendu — le cœur

Point d'entrée unique, volontairement étroit :

```ts
interface VideoRenderer {
  render(
    spec: RenderSpec,
    sink: OutputSink,                   // écriture au fil de l'eau (§ encodage)
    onProgress: (p: Progress) => void
  ): Promise<RenderedVideo>;
}

interface RenderSpec {
  width: number; height: number; fps: 30 | 60;
  verses: VerseClip[];                 // texte, traduction, AudioBuffer, durée
  style: SubtitleStyle;                // police, tailles, couleurs, position, marge, mode
  background: BackgroundSpec;          // dégradé | image | vidéo locale
  watermark?: string;
  maxDurationSec: 900;                 // plafond dur : 15 minutes
}
```

**Construction de la timeline** (`packages/core`)
- Un `VerseClip` = un MP3 décodé en `AudioBuffer`. La durée est **mesurée**, pas estimée.
- Silences : 800 ms avant le premier verset, 300 ms entre versets (réglables).
- `timeline = [{start, end, verseIndex}, …]` — source de vérité pour l'image **et** le son.

**Rendu des images**
- Un `<canvas>` hors écran aux dimensions cibles.
- Fond : dégradé animé, image, ou vidéo locale.
- Voile d'assombrissement avec opacité réglable.
- Texte arabe : `ctx.direction = 'rtl'`, police Uthmanic Hafs, retour à la ligne par mesure
  de mots. Le façonnage arabe est assuré par le moteur de texte de la plateforme.
- Traduction sous l'arabe, retour à la ligne, taille indépendante.
- Mode **verset entier** (exact) ou **mot par mot** (estimation proportionnelle à la longueur
  des mots, honnêtement annoncée comme estimation dans l'UI).

**Encodage — 15 minutes imposent l'écriture en flux**
- 15 min à 30 fps = 27 000 images ; un MP4 complet de cette taille ne tient pas en mémoire
  sur un téléphone. La sortie est donc écrite **au fil de l'eau** : `File System Access API`
  quand elle est disponible (Chrome/Edge/Electron), `OPFS` sinon (Android, Safari), avec
  repli mémoire uniquement pour les vidéos courtes.
- Conteneur : **MP4 fragmenté**, finalisé en fin de rendu. Chemin nominal `VideoEncoder`
  (H.264) + `AudioEncoder` (AAC) + muxeur, horodatage déterministe `i / fps`. Le rendu avance
  aussi vite que l'appareil le permet, pas en temps réel.
- Repli quand WebCodecs est absent : `canvas.captureStream()` + `MediaRecorder`, rendu en
  temps réel, conteneur MP4 si la plateforme le permet, sinon WebM annoncé tel quel.
- **Vidéo de fond** : seuls les MP4/H.264 sont acceptés, décodés image par image via
  `VideoDecoder` + démuxage JS. Tout autre format est refusé avec un message explicite plutôt
  que de produire silencieusement une vidéo cassée.
- **Plafond dur** : au-delà de 15 minutes de timeline, le rendu est refusé avant de commencer,
  avec la durée estimée affichée. Pas de rendu tronqué en silence.

**Progression et annulation** : `onProgress` remonte l'avancement réel (image courante,
temps restant estimé) ; le rendu est annulable proprement — fermeture des encodeurs, purge du
fichier partiel.

### 6.4 Persistance locale

IndexedDB (via `idb`), aucune donnée ne sort de l'appareil.

| Base | Contenu |
|---|---|
| `drafts` | projets en cours (sélection, style, fond) |
| `history` | vidéos rendues : métadonnées + fichier |
| `offline` | sourates téléchargées : JSON + MP3 |
| `settings` | langue, thème, préférences de rendu |

`Zustand` + middleware `persist` sur un adaptateur IndexedDB. **Conséquence directe** : un
rechargement ne détruit plus la configuration (défaut n°7 de l'audit).

**Quota** : une vidéo de 15 minutes pèse facilement 200 Mo. Rétention par défaut de **3
vidéos**, purge manuelle, et avertissement avant d'atteindre le quota du navigateur. Les
vidéos sont supprimables individuellement depuis l'historique.

### 6.5 État et navigation

- `Zustand` pour l'état applicatif (sélection, style, file de rendu).
- File de rendu persistée. **Une reprise relance le rendu depuis le début** : on ne reprend
  pas à mi-encodage (le coût de conception d'un MP4 fragmenté reprenable n'est pas justifié
  pour un bénéfice que l'utilisateur ne perçoit quasiment pas). L'UI le dit clairement.
- Routage Next (`app/`), URLs stables et lisibles : `/sourate/36`, `/studio`, `/rendu/{id}`.

### 6.6 Emballages natifs

**Android — Capacitor**
- `webDir: ../../apps/web/out`. Aucun code métier dans la coquille.
- Plugins : partage de fichier, statut réseau, stockage (facultatif).
- Cible : `minSdk 24`, `targetSdk` courant. Build AAB signé.
- Prérequis machine : **JDK 17 + Android SDK** (absents aujourd'hui, à installer au lot 6).

**Windows — Electron**
- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, CSP stricte.
- Chargement de `out/` via un protocole `app://` enregistré (le `file://` casse les modules ES
  et les fetch relatifs).
- `electron-builder` → installateur NSIS. Mises à jour via `electron-updater` + GitHub Releases,
  donc **sans serveur à maintenir**.
- Choisi plutôt que Tauri : pas besoin de Rust ni de MSVC, déjà absents de la machine.
- **v1 non signée.** L'installateur déclenchera l'avertissement SmartScreen. Un certificat
  de signature de code coûte ~200–400 €/an et exige une vérification d'identité de plusieurs
  jours : c'est un lot séparé, après la première publication. Le Microsoft Store est
  facultatif — un `.exe` suffit pour distribuer sur Windows.

### 6.7 Distribution

| Cible | Livrable | Mise à jour |
|---|---|---|
| Web | dossier statique | redéploiement |
| Android | AAB signé | Google Play |
| Windows | `.exe` NSIS (non signé en v1) | GitHub Releases via `electron-updater` |

Domaine de production : Vercel par défaut, **configurable par variable d'environnement** —
il alimente le `canonical`, les URLs Open Graph, le `sitemap.xml`, la CSP et le flux de mise à
jour. Aucune valeur codée en dur.

---

## 7. Périmètre fonctionnel v1

**Repris** : bibliothèque 114 sourates, recherche FR/EN/AR/numéro, sélection de versets,
studio (récitateur, format 16:9 / 9:16 / 1:1 / 4:5, taille, couleur, voile, traduction, fond),
aperçu, rendu, résultat, téléchargement.

**Corrigé** : configuration persistante · statut de rendu réel (plus de faux « prête ») ·
vrais 404 · listes virtualisées et cache · contraste ≥ 4.5:1, labels associés, `<main>` ·
titres et contenu rendus au build · en-têtes de sécurité.

**Ajouté en v1** :

| Fonction | Note |
|---|---|
| ~40 récitateurs, recherche, favoris | liste curée manuellement, qualité avant quantité |
| Traductions multiples (fr, en) | dépend des licences par traduction (§9) |
| Style de sous-titre : verset entier / mot par mot | mot par mot = estimation, annoncée comme telle |
| Fonds : dégradés animés, import local (image/vidéo MP4-H.264), banque CC0 embarquée | garantit le hors-ligne complet, aucune clé API |
| Brouillons + historique | IndexedDB, rétention de 3 vidéos |
| File de rendu, relance après fermeture | découle du rendu local long |
| Partage natif du fichier | Android ; sur Windows, « révéler dans le dossier » |
| Hors-ligne : télécharger une sourate + son audio | Service Worker + IndexedDB |
| Interface FR / EN / AR avec RTL | i18next |

**Reporté en v1.1** : import de récitation personnelle (interface de waveform et assignation
manuelle des versets — gros lot qui concurrence le moteur de rendu), recherche de fonds
Pexels/Pixabay en ligne (exige une clé API, donc un proxy serveur), rendu de sourate entière.

---

## 8. Qualité

**Accessibilité** : contraste ≥ 4.5:1 sur tous les jetons de texte, `<main>` sur chaque page,
labels associés aux champs, gestion du focus dans les modales, navigation clavier complète,
`prefers-reduced-motion` respecté.

**Performance** : pages sourate virtualisées (une sourate de 286 versets ne doit pas produire
54 000 px de DOM) · données immuables servies avec un cache long · audio en `Range` ·
le rendu ne bloque jamais l'interface (encodeurs asynchrones, progression réelle).

**SEO (web uniquement)** : 114 pages pré-rendues avec `<h1>`, titre et description par sourate,
`canonical`, Open Graph, `sitemap.xml`, `robots.txt`, icônes et manifeste.

**Sécurité** : CSP, HSTS, `X-Frame-Options`, `Referrer-Policy`, `X-Content-Type-Options` côté
web (fichier `vercel.json`) et Electron ; aucun secret dans le client ; aucune télémétrie en v1.

**Tests**
- `Vitest` : construction de timeline, allocation des durées mot par mot, génération d'URL
  audio, validation des données, refus au-delà de 15 minutes.
- `Playwright` : parcours complet sur le web — choisir 3 versets, rendre, vérifier que le
  fichier produit est un MP4 dont la durée correspond à la timeline à ±0,1 s.
- Checklist manuelle Android et Windows (rendu, partage, hors-ligne, mise à jour).

---

## 9. Légal et attribution

- **Tanzil** : attribution visible + lien vers tanzil.net, texte non modifié. Obligatoire.
  Une page « À propos » et la fiche de store le mentionnent.
- **EveryAyah** : **aucune licence écrite trouvée** au 15/11/2026. Action : demander une
  confirmation écrite au support (Quran.com) avant publication. Plan de repli si refus :
  MP3Quran.net (sourate entière, découpe locale au silence). À noter : l'absence de licence
  écrite ne bloque pas le développement, seulement la publication.
- **Police Uthmanic Hafs (KFGQPC)** : redistribuée dans les trois paquets. Licence à vérifier
  et à documenter dans `data/source/ATTRIBUTION.md` avant intégration ; sous-ensemble de
  caractères (subset) obligatoire pour ne pas charger plusieurs mégaoctets par page web.
- **Fonds** : banque CC0 embarquée, licence de chaque clip tracée ; Pexels/Pixabay ne sont
  pas utilisés en v1.
- **Traductions** : licence à vérifier **une par une** avant intégration ; en cas de doute,
  ne pas intégrer.
- **Confidentialité** : aucune collecte, aucun compte, aucun analytics ⇒ politique de
  confidentialité courte et formulaire « Data safety » déclarant zéro collecte.

---

## 10. Risques

| Risque | Impact | Mitigation |
|---|---|---|
| EveryAyah refuse la redistribution | élevé | demande écrite tôt ; repli MP3Quran + découpe locale |
| Licence d'une traduction incompatible | moyen | vérifier avant intégration ; retirer la langue concernée |
| WebCodecs absent sur un WebView | moyen | moteur de repli MediaRecorder, qualité annoncée |
| Rendu de 15 min trop lent sur téléphone ancien | moyen | écriture en flux, progression, plafond de résolution selon l'appareil, annulation |
| Quota de stockage saturé par les vidéos | moyen | rétention de 3 vidéos, purge, avertissement |
| Outils Android absents de la machine | moyen | installer JDK 17 + SDK au lot 6, avant d'en avoir besoin |
| SmartScreen bloque l'installateur non signé | moyen | assumé en v1, documenté sur la page de téléchargement ; signature en lot ultérieur |
| Clé de signature Play perdue | grave | sauvegarde hors dépôt, documentée, testée |

---

## 11. Lots

1. **Socle** — monorepo, pipeline de données, bibliothèque, lecteur de sourate, i18n de base.
2. **Studio** — sélection, réglages, aperçu audio, persistance des brouillons.
3. **Moteur de rendu** — timeline, canvas, WebCodecs, écriture en flux, muxeur, repli, file.
4. **Résultat et partage** — lecteur, téléchargement, partage, historique.
5. **Web publiable** — SEO, accessibilité, cache, en-têtes, déploiement.
6. **Android** — Capacitor, signature, test sur appareil, fiche Play.
7. **Windows** — Electron, protocole, installateur, mises à jour.

Chaque lot se termine par ses tests et une démonstration. Les lots 1 à 4 sont séquentiels ;
5, 6 et 7 peuvent se chevaucher. **v1.1** : import de récitation personnelle, fonds en ligne,
rendu de sourate entière, signature Windows.

---

## 12. Définition de « terminé » pour la v1

- Sur les trois plateformes, un utilisateur produit une vidéo MP4 avec audio synchronisé,
  sans connexion, pour une sourate déjà téléchargée.
- Une vidéo de 15 minutes aboutit sans saturer la mémoire de l'appareil.
- Aucune action ne dépend d'un serveur.
- Le texte correspond à Tanzil, l'attribution est visible, les crédits sont complets.
- Accessibilité : aucun échec de contraste, `<main>` et labels présents.
- Les 114 pages web sont indexables.
- Android : AAB signé installable depuis un test interne Play. Windows : `.exe` qui s'installe,
  se lance et se met à jour — non signé, avertissement SmartScreen documenté.

---

## 13. Ce qui reste à décider par le constructeur

- Choix exact du muxeur MP4 fragmenté et de ses paramètres de bitrate par résolution.
- Liste finale des récitateurs retenus (qualité et complétude avant nombre).
- Stratégie de retour à la ligne arabe (mesure par mot vs bibliothèque de justification).
- Découpage interne de `packages/render` (modules et frontières).
- Taille et composition de la banque de clips CC0 embarquée.
- Sélection des traductions fr/en sous réserve de licence.
