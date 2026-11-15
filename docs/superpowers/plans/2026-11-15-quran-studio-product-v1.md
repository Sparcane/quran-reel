# Quran Studio — Plan d'implémentation du produit (v1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construire l'application web Quran Studio — bibliothèque des 114 sourates, studio de mise en forme, rendu vidéo MP4 100 % local jusqu'à 15 minutes — prête à être empaquetée pour Android et Windows.

**Architecture:** Monorepo npm workspaces. Next.js en `output: 'export'` produit 114 pages pré-rendues et un dossier statique réutilisable tel quel par les emballages natifs. Trois paquets : `core` (types, données, timeline), `render` (compositeur canvas + encodeurs WebCodecs/MediaRecorder, exécuté dans un Worker), `web` (UI). Aucun serveur : les données sont des fichiers JSON immuables, l'audio vient d'EveryAyah en direct, tout le rendu et le stockage sont locaux.

**Tech Stack:** Next.js 15 (App Router, export statique), React 19, TypeScript strict, Tailwind CSS, Zustand, `idb`, `i18next`, WebCodecs + `mp4-muxer`, `mp4box`, Vitest, Playwright, Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-15-quran-studio-rebuild-design.md`

## Global Constraints

- Node ≥ 26, npm ≥ 11. Pas de pnpm, pas de yarn.
- TypeScript `strict: true`, aucun `any` implicite, aucun `@ts-ignore`.
- **Aucun backend.** Aucun appel réseau au moment du rendu, sauf les MP3 EveryAyah non encore téléchargés.
- **Durée maximale d'une vidéo : 900 s.** Au-delà, refus avant le début du rendu.
- Formats de sortie, dimensions exactes : `16:9` = 1920×1080, `9:16` = 1080×1920, `1:1` = 1080×1080, `4:5` = 1080×1350. Cadence par défaut 30 fps.
- Texte coranique : Tanzil, **verbatim**, jamais modifié. Attribution visible sur `/a-propos` avec lien vers `tanzil.net`.
- Contraste minimal de tout texte : **4.5:1**. `<main>` sur chaque page. Tout champ de formulaire a un label associé.
- Aucune télémétrie, aucun cookie, aucun compte.
- Chaque tâche se termine par un commit. Messages au format `feat:` / `test:` / `chore:`.

### Budget de performance (contraintes opposables)

- Bibliothèque : moins de **2000 nœuds DOM**, LCP < 1,5 s avec un CPU ralenti ×4.
- Page sourate : moins de **2000 nœuds DOM** quel que soit le nombre de versets (virtualisation obligatoire).
- Débit de rendu : ≥ **2,0× le temps réel** en 1080p sur un ordinateur de bureau courant ; ≥ **0,8×** sur un Android milieu de gamme 2021.
- Mémoire de pointe pendant un rendu de 15 min : **< 400 Mo**.
- L'interface ne doit jamais être bloquée plus de **50 ms** pendant un rendu.
- Premier rendu d'image en moins de **1 s** après le clic sur « Générer ».
- Décodage audio : concurrence maximale de **4**, préchargement de 3 versets en avance pendant le rendu.

## Review Focus

Ces cas ne relèvent d'aucune exigence explicite de la spec, mais casseront le produit s'ils ne sont pas traités. Chacun est rattaché à une tâche par un test.

1. **Le verset le plus long du Coran (2:282, ~350 caractères)** — le texte doit se replier sur plusieurs lignes et tenir dans le cadre sans débordement ni chevauchement de la traduction.
2. **Un MP3 absent sur le CDN** (des dossiers EveryAyah sont incomplets : `Menshawi_32kbps` a 303 fichiers manquants) — le rendu doit échouer avec un message nommant le verset, jamais produire un silence.
3. **Quota de stockage saturé en cours de rendu** — le rendu doit s'arrêter proprement, conserver les fichiers déjà produits supprimables, et afficher une action de purge ; jamais un fichier tronqué présenté comme valide.
4. **Une vidéo de fond en HEVC ou VP9** — refus immédiat avec message explicite ; jamais de rendu silencieusement dégradé.
5. **Zéro verset sélectionné** — le bouton de génération est désactivé avec une raison visible, pas un rendu vide de 0,8 s.

---

## Structure des fichiers

```
quran-reel/
  package.json                         workspaces, scripts racine
  tsconfig.base.json                   options TS partagées
  eslint.config.js  .prettierrc  .gitignore  .editorconfig

  data/source/                         Tanzil + traductions téléchargés, ATTRIBUTION.md
  scripts/
    build-data.ts                      source → public/data
    verify-data.ts                     contrôles d'intégrité
    fixtures/                          extraits figés pour les tests

  packages/core/
    src/types.ts                       contrats de données partagés
    src/timeline.ts                    buildTimeline
    src/word-timing.ts                 allocateWordTimings
    src/audio-url.ts                   audioUrl
    src/format.ts                      formatDuration, clamp, padding
    test/*.test.ts

  packages/render/
    src/types.ts                       RenderSpec, RenderedVideo, Progress
    src/text-layout.ts                 mise en page arabe + traduction
    src/background.ts                  BackgroundPainter (dégradé, image, vidéo)
    src/compositor.ts                  dessin d'une image à l'instant t
    src/sink.ts                        OutputSink (mémoire, OPFS, File System Access)
    src/encoder-webcodecs.ts           chemin nominal
    src/encoder-mediarecorder.ts       repli
    src/worker.ts                      orchestrateur dans le Worker
    src/queue.ts                       file de rendu persistée
    src/index.ts                       VideoRenderer
    test/*.test.ts

  apps/web/
    next.config.ts                     output: 'export'
    app/layout.tsx  app/page.tsx
    app/bibliotheque/page.tsx
    app/sourate/[id]/page.tsx
    app/studio/page.tsx
    app/rendu/[id]/page.tsx
    app/a-propos/page.tsx
    src/components/…                   un composant par fichier
    src/lib/…                          état, i18n, accès données, persistance
    public/data/                       généré par build-data
    public/fonts/                      Uthmanic Hafs (subset)
```

Principe de découpage : un fichier = une responsabilité. `packages/render` ne connaît ni React ni Next ; `apps/web` ne connaît pas WebCodecs directement.

---

# Lot 1 — Socle

### Task 1: Échafaudage du monorepo

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc`, `.gitignore`, `.editorconfig`
- Create: `apps/web/package.json`, `apps/web/next.config.ts`, `apps/web/tsconfig.json`, `apps/web/app/layout.tsx`, `apps/web/app/page.tsx`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`

**Interfaces:**
- Consumes: rien.
- Produces: `@quran/core` (paquet workspace), commandes racine `npm run build`, `npm run test`, `npm run lint`.

- [ ] **Step 1: Initialiser le dépôt**

```bash
git init
npm init -y
```

- [ ] **Step 2: Déclarer les workspaces et les scripts racine dans `package.json`**

`"workspaces": ["apps/*", "packages/*"]`, scripts : `build`, `dev`, `test`, `lint`, `format`, `build:data`, `verify:data`.

- [ ] **Step 3: Créer la coquille Next avec export statique**

`apps/web/next.config.ts` contient `output: 'export'`, `images: { unoptimized: true }`, `trailingSlash: true`.

- [ ] **Step 4: Vérifier que le build produit un export**

Run: `npm run build`
Expected: PASS, création de `apps/web/out/index.html`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold monorepo with next static export"
```

---

### Task 2: Contrats de données

**Files:**
- Create: `packages/core/src/types.ts`, `packages/core/src/format.ts`
- Test: `packages/core/test/types.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces: tous les types listés ci-dessous, consommés par chaque tâche suivante.

```ts
export type SurahId = number;                    // 1..114
export type Lang = 'fr' | 'en';
export interface SurahMeta {
  number: SurahId; nameAr: string; nameFr: string; nameEn: string;
  verseCount: number; revelation: 'meccan' | 'medinan';
}
export interface Verse { number: number; arabic: string; translations: Record<Lang, string>; }
export interface SurahData extends SurahMeta { verses: Verse[]; }
export interface Reciter {
  id: string;
  name: Record<'fr' | 'en' | 'ar', string>;
  folder: string;            // dossier EveryAyah
  bitrate: number;           // kbps, informatif
}
export interface VerseRef { surah: SurahId; verse: number; }
```

`format.ts` produit `pad3(n: number): string`, `formatDuration(sec: number): string` (`m:ss`), `clamp(n, min, max): number`.

- [ ] **Step 1: Écrire le test**

```ts
expect(pad3(7)).toBe('007');
expect(pad3(114)).toBe('114');
expect(pad3(1234)).toBe('1234');
expect(formatDuration(0)).toBe('0:00');
expect(formatDuration(75)).toBe('1:15');
expect(formatDuration(900)).toBe('15:00');
```

- [ ] **Step 2: Lancer le test, le voir échouer** — `npx vitest run packages/core/test/types.test.ts` → FAIL, module introuvable.

- [ ] **Step 3: Implémenter `types.ts` et `format.ts`**

- [ ] **Step 4: Relancer le test** → PASS.

- [ ] **Step 5: Commit** — `feat: add core data contracts`

---

### Task 3: Pipeline de données — texte Tanzil

**Files:**
- Create: `scripts/build-data.ts`, `scripts/fixtures/tanzil-sample.txt`, `data/source/ATTRIBUTION.md`
- Test: `scripts/test/build-data.test.ts`

**Interfaces:**
- Consumes: `SurahMeta`, `Verse`, `SurahData` de `@quran/core`.
- Produces: `public/data/surahs-index.json` (114 entrées), `public/data/surahs/{001..114}.json`.

- [ ] **Step 1: Écrire le test sur l'échantillon figé**

```ts
const index = parseTanzil(fixture);
expect(index).toHaveLength(114);
expect(index[0]).toMatchObject({ number: 1, nameAr: 'الفاتحة', verseCount: 7, revelation: 'meccan' });
expect(index[1]).toMatchObject({ number: 2, verseCount: 286, revelation: 'medinan' });
expect(index.reduce((n, s) => n + s.verseCount, 0)).toBe(6236);
```

- [ ] **Step 2: Lancer, voir échouer** → `parseTanzil is not defined`.

- [ ] **Step 3: Implémenter `parseTanzil(source: string): SurahMeta[]` et `writeSurahs(...)`**

La source Tanzil est un fichier `surah|verse|text` ; le script télécharge une fois vers `data/source/`, n'écrase jamais un fichier existant, et écrit `ATTRIBUTION.md` avec l'URL et la date.

- [ ] **Step 4: Relancer** → PASS, puis `npm run build:data` génère 114 fichiers.

- [ ] **Step 5: Commit** — `feat: add tanzil data pipeline`

---

### Task 4: Pipeline de données — traductions

**Files:**
- Create: `scripts/build-translations.ts`, `data/source/TRANSLATIONS.md`
- Modify: `scripts/build-data.ts`
- Test: `scripts/test/build-translations.test.ts`

**Interfaces:**
- Consumes: `parseTanzil` de Task 3.
- Produces: le champ `translations: { fr, en }` rempli dans chaque `surahs/{n}.json`.

- [ ] **Step 1: Écrire le test**

```ts
const merged = mergeTranslations(tanzil, { fr: frFixture, en: enFixture });
expect(merged[1].verses[0].translations.fr).toContain('Louange');
expect(merged[1].verses[0].arabic).toMatch(/^بِسْمِ/);
expect(Object.keys(merged)).toHaveLength(114);
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Implémenter `mergeTranslations(...)`, vérifier qu'aucune traduction ne manque**

Le script échoue bruyamment si une clé `fr` ou `en` est absente pour un verset. `TRANSLATIONS.md` documente la licence de chaque traduction ; une traduction sans licence vérifiée n'est pas intégrée.

- [ ] **Step 4: Relancer** → PASS.

- [ ] **Step 5: Commit** — `feat: merge verified translations into surah data`

---

### Task 5: Catalogue des récitateurs et URL audio

**Files:**
- Create: `apps/web/public/data/reciters.json`, `packages/core/src/audio-url.ts`
- Test: `packages/core/test/audio-url.test.ts`

**Interfaces:**
- Consumes: `Reciter`, `VerseRef`, `pad3` de Task 2.
- Produces: `audioUrl(reciter: Reciter, ref: VerseRef): string`.

- [ ] **Step 1: Écrire le test**

```ts
const maher = { id: 'maher', folder: 'MaherAlMuaiqly128kbps', bitrate: 128,
  name: { fr: 'Maher', en: 'Maher', ar: 'ماهر' } } as Reciter;
expect(audioUrl(maher, { surah: 36, verse: 1 }))
  .toBe('https://everyayah.com/data/MaherAlMuaiqly128kbps/036001.mp3');
expect(audioUrl(maher, { surah: 2, verse: 282 }))
  .toBe('https://everyayah.com/data/MaherAlMuaiqly128kbps/002282.mp3');
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Implémenter `audioUrl` et écrire `reciters.json`**

Minimum 8 récitateurs dont les dossiers sont complets, vérifiés par HEAD sur 3 versets répartis. Chaque entrée porte un nom fr/en/ar.

- [ ] **Step 4: Relancer** → PASS.

- [ ] **Step 5: Commit** — `feat: add reciter catalog and deterministic audio urls`

---

### Task 6: Vérification d'intégrité des données

**Files:**
- Create: `scripts/verify-data.ts`
- Test: `scripts/test/verify-data.test.ts`

**Interfaces:**
- Consumes: les fichiers générés par les Tasks 3–5.
- Produces: `npm run verify:data` sort en code 0 ou 1.

- [ ] **Step 1: Écrire le test**

```ts
expect(() => verifyIndex({ surahs: brokenIndex })).toThrow(/verse count/);
expect(() => verifySurah({ ...surah2, verses: [] })).toThrow(/empty/);
expect(verifyIndex({ surahs: goodIndex })).not.toThrow();
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Implémenter les trois contrôles**

(1) 114 sourates et 6236 versets au total ; (2) aucun texte vide ; (3) pour chaque récitateur, HEAD sur le premier verset de 3 sourates choisies retourne 200 et `content-type: audio/mpeg`.

- [ ] **Step 4: Relancer** → PASS, puis `npm run verify:data` → code 0.

- [ ] **Step 5: Commit** — `chore: add data integrity verification`

---

### Task 7: Bibliothèque des sourates

**Files:**
- Create: `apps/web/app/bibliotheque/page.tsx`, `apps/web/src/components/SurahCard.tsx`, `apps/web/src/components/SurahSearch.tsx`, `apps/web/src/lib/surahs.ts`
- Test: `apps/web/test/bibliotheque.test.tsx`

**Interfaces:**
- Consumes: `SurahMeta` (Task 2), `surahs-index.json` (Task 3).
- Produces: `filterSurahs(index: SurahMeta[], query: string): SurahMeta[]` — recherche sur nom FR/EN/AR et numéro, insensible à la casse et aux diacritiques arabes.

- [ ] **Step 1: Écrire le test**

```tsx
render(<Bibliotheque index={index} />);
expect(screen.getAllByRole('link')).toHaveLength(114);
await user.type(screen.getByLabelText('Rechercher une sourate'), 'yassin');
expect(screen.getAllByRole('link')).toHaveLength(1);
await user.clear(input); await user.type(input, '36');
expect(screen.getByRole('link', { name: /Yâ-Sîn/ })).toBeInTheDocument();
await user.clear(input); await user.type(input, 'zzz');
expect(screen.getByText('Aucune sourate trouvée')).toBeInTheDocument();
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Implémenter**

Chaque sourate est un **vrai `<a>`** (`next/link`), pas un bouton. Grille virtualisée si le nombre de nœuds dépasse le budget. Recherche exécutée en `useDeferredValue`.

- [ ] **Step 4: Relancer** → PASS. Vérifier le budget DOM dans le même test : `expect(container.querySelectorAll('*').length).toBeLessThan(2000)`.

- [ ] **Step 5: Commit** — `feat: add surah library with instant search`

---

### Task 8: Lecteur de sourate et sélection de versets

**Files:**
- Create: `apps/web/app/sourate/[id]/page.tsx`, `apps/web/src/components/VerseList.tsx`, `apps/web/src/components/VerseRow.tsx`, `apps/web/src/lib/verses.ts`
- Test: `apps/web/test/sourate.test.tsx`

**Interfaces:**
- Consumes: `SurahData`, `VerseRef` (Task 2).
- Produces: `toSelection(refs: VerseRef[]): VerseRef[]` (triée, dédoublonnée, contiguë par sourate) ; événement « Studio » qui pousse la sélection dans le store (Task 10).

- [ ] **Step 1: Écrire le test**

```tsx
render(<VerseList surah={surah2} onStudio={onStudio} />);
expect(screen.getAllByRole('listitem')).toHaveLength(60);       // virtualisation
await user.click(screen.getByLabelText('Sélectionner le verset 2'));
await user.click(screen.getByLabelText('Sélectionner le verset 3'));
await user.click(screen.getByRole('button', { name: /Studio/ }));
expect(onStudio).toHaveBeenCalledWith([
  { surah: 2, verse: 2 }, { surah: 2, verse: 3 },
]);
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Implémenter**

Liste virtualisée (`@tanstack/react-virtual`), 60 éléments montés à la fois. « Tout sélectionner » opère sur toute la sourate, pas seulement le rendu visible. `generateStaticParams` produit les 114 pages.

- [ ] **Step 4: Relancer** → PASS, et `expect(container.querySelectorAll('*').length).toBeLessThan(2000)` sur la sourate 2.

- [ ] **Step 5: Commit** — `feat: add virtualized surah reader with verse selection`

---

### Task 9: Internationalisation FR / EN / AR

**Files:**
- Create: `apps/web/src/lib/i18n.ts`, `apps/web/src/locales/fr.json`, `apps/web/src/locales/en.json`, `apps/web/src/locales/ar.json`
- Modify: `apps/web/app/layout.tsx`
- Test: `apps/web/test/i18n.test.tsx`

**Interfaces:**
- Consumes: rien.
- Produces: `useT(): (key: string) => string`, et le réglage `dir` appliqué sur `<html>`.

- [ ] **Step 1: Écrire le test**

```tsx
expect(renderWithLang('fr').getByText('Bibliothèque')).toBeInTheDocument();
expect(renderWithLang('en').getByText('Library')).toBeInTheDocument();
const ar = renderWithLang('ar');
expect(ar.getByText('المكتبة')).toBeInTheDocument();
expect(document.documentElement.getAttribute('dir')).toBe('rtl');
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Implémenter**

`i18next` + `react-i18next`, langue par défaut `fr`, détection depuis le stockage local puis `navigator.language`. Aucune clé manquante : un test parcourt les trois fichiers et vérifie l'égalité des jeux de clés.

- [ ] **Step 4: Relancer** → PASS.

- [ ] **Step 5: Commit** — `feat: add fr/en/ar i18n with rtl support`

---

# Lot 2 — Studio

### Task 10: Store de studio persistant

**Files:**
- Create: `apps/web/src/lib/storage.ts`, `apps/web/src/lib/studio-store.ts`
- Test: `apps/web/test/studio-store.test.ts`

**Interfaces:**
- Consumes: `VerseRef`, `Reciter` (Task 2).
- Produces:

```ts
interface StudioSettings {
  reciterId: string; aspectRatio: '16:9' | '9:16' | '1:1' | '4:5';
  arabicSize: number;          // 24..120
  translationSize: number;     // 16..72
  showTranslation: boolean; translationLang: Lang;
  textColor: string; overlayOpacity: number;   // 0..90
  subtitleMode: 'verse' | 'word';
  background: BackgroundSelection;
}
```

`useStudioStore()` expose `selection`, `settings`, `setSelection`, `patchSettings`, `reset`.

- [ ] **Step 1: Écrire le test**

```ts
const s = useStudioStore.getState();
s.setSelection([{ surah: 2, verse: 2 }]);
s.patchSettings({ aspectRatio: '9:16' });
await flushPersist();
expect(loadPersistedStudio().settings.aspectRatio).toBe('9:16');
expect(loadPersistedStudio().selection).toEqual([{ surah: 2, verse: 2 }]);
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Implémenter**

`Zustand` + `persist` avec un adaptateur `idb` (`createJSONStorage`). Version de schéma `1` et migration explicite. **Le studio ne redirige plus vers la bibliothèque si l'état est vide** : il affiche un état vide avec un lien.

- [ ] **Step 4: Relancer** → PASS, y compris après réhydratation simulée.

- [ ] **Step 5: Commit** — `feat: add persistent studio store`

---

### Task 11: Réglages du studio

**Files:**
- Create: `apps/web/app/studio/page.tsx`, `apps/web/src/components/studio/AspectRatioPicker.tsx`, `apps/web/src/components/studio/TypographyControls.tsx`, `apps/web/src/components/studio/ColorControls.tsx`
- Test: `apps/web/test/studio-controls.test.tsx`

**Interfaces:**
- Consumes: `StudioSettings` (Task 10).
- Produces: `dimensionsFor(ratio: AspectRatio): { width: number; height: number }`.

- [ ] **Step 1: Écrire le test**

```ts
expect(dimensionsFor('16:9')).toEqual({ width: 1920, height: 1080 });
expect(dimensionsFor('9:16')).toEqual({ width: 1080, height: 1920 });
expect(dimensionsFor('1:1')).toEqual({ width: 1080, height: 1080 });
expect(dimensionsFor('4:5')).toEqual({ width: 1080, height: 1350 });
```

```tsx
await user.click(screen.getByLabelText('Format 9:16'));
expect(useStudioStore.getState().settings.aspectRatio).toBe('9:16');
await user.clear(screen.getByLabelText('Taille du texte arabe'));
await user.type(screen.getByLabelText('Taille du texte arabe'), '150');
expect(useStudioStore.getState().settings.arabicSize).toBe(120);   // clampé
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Implémenter**

Chaque contrôle a un label associé (`htmlFor`/`id`) et une valeur bornée. Les tailles sont bornées à la saisie, pas seulement à l'affichage.

- [ ] **Step 4: Relancer** → PASS.

- [ ] **Step 5: Commit** — `feat: add studio format and typography controls`

---

### Task 12: Fonds — couleurs et dégradés animés

**Files:**
- Create: `packages/render/src/background.ts`
- Test: `packages/render/test/background.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces:

```ts
export interface BackgroundPainter {
  paint(ctx: OffscreenCanvasRenderingContext2D, t: number): void;
  readonly ready: boolean;
  dispose(): void;
}
export function createGradientPainter(sel: GradientSelection, size: Size): BackgroundPainter;
export function createImagePainter(bitmap: ImageBitmap, size: Size): BackgroundPainter;
```

- [ ] **Step 1: Écrire le test**

```ts
const p = createGradientPainter({ kind: 'gradient', from: '#0a0a0a', to: '#1e3a5f', angle: 45, motion: true }, { width: 8, height: 8 });
const canvas = new OffscreenCanvas(8, 8);
const ctx = canvas.getContext('2d')!;
p.paint(ctx, 0);   const a = ctx.getImageData(4, 4, 1, 1).data.join();
p.paint(ctx, 4);   const b = ctx.getImageData(4, 4, 1, 1).data.join();
expect(a).not.toBe(b);          // le dégradé bouge
expect(p.ready).toBe(true);
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Implémenter**

Dégradé animé = décalage sinusoïdal de l'angle, période 20 s, calculé depuis `t` donc **déterministe** (indispensable pour un rendu hors temps réel).

- [ ] **Step 4: Relancer** → PASS.

- [ ] **Step 5: Commit** — `feat: add deterministic gradient and image backgrounds`

---

### Task 13: Fonds — import local et validation de format

**Files:**
- Create: `apps/web/src/lib/import-background.ts`, `apps/web/src/components/studio/BackgroundPicker.tsx`
- Test: `apps/web/test/import-background.test.ts`

**Interfaces:**
- Consumes: `createImagePainter` (Task 12).
- Produces: `validateBackgroundFile(file: File): Promise<{ ok: true; kind: 'image' } | { ok: true; kind: 'video'; codec: 'h264' } | { ok: false; reason: string }>`.

- [ ] **Step 1: Écrire le test**

```ts
expect(await validateBackgroundFile(png)).toEqual({ ok: true, kind: 'image' });
expect(await validateBackgroundFile(mp4H264)).toEqual({ ok: true, kind: 'video', codec: 'h264' });
expect(await validateBackgroundFile(hevc)).toEqual({ ok: false, reason: 'codec' });
expect(await validateBackgroundFile(textFile)).toEqual({ ok: false, reason: 'type' });
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Implémenter**

Détection par `file.type` **et** inspection de l'en-tête du fichier, pas par extension seule. Refus explicite affiché à l'utilisateur avec le motif.

- [ ] **Step 4: Relancer** → PASS.

- [ ] **Step 5: Commit** — `feat: add local background import with codec validation`

---

### Task 14: Moteur d'aperçu audio

**Files:**
- Create: `apps/web/src/lib/preview-audio.ts`, `apps/web/src/components/studio/PreviewButton.tsx`
- Test: `apps/web/test/preview-audio.test.ts`

**Interfaces:**
- Consumes: `audioUrl` (Task 5), `buildTimeline` (Task 16 — créé avant la fin du lot 3, l'appel est injecté).
- Produces: `class PreviewPlayer { load(refs, reciterId): Promise<void>; play(): Promise<void>; stop(): void; readonly state: 'idle' | 'loading' | 'playing' | 'blocked' }`.

- [ ] **Step 1: Écrire le test**

```ts
const player = new PreviewPlayer(fakeFetch, fakeAudioContext);
await player.load([{ surah: 1, verse: 1 }], 'maher');
fakeAudioContext.suspendForUserGesture();
await player.play();
expect(player.state).toBe('blocked');
expect(screen.getByText('Cliquez pour activer le son')).toBeInTheDocument();
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Implémenter**

`AudioContext` créé au premier geste utilisateur. Un refus de `resume()` place l'état à `blocked` et affiche une action explicite — plus jamais un aperçu silencieusement mort.

- [ ] **Step 4: Relancer** → PASS.

- [ ] **Step 5: Commit** — `feat: add audio preview with blocked-state recovery`

---

### Task 15: Brouillons

**Files:**
- Create: `apps/web/src/lib/drafts.ts`, `apps/web/src/components/studio/DraftsMenu.tsx`
- Test: `apps/web/test/drafts.test.ts`

**Interfaces:**
- Consumes: `StudioSettings` (Task 10).
- Produces: `interface Draft { id: string; name: string; updatedAt: number; selection: VerseRef[]; settings: StudioSettings }` ; `saveDraft`, `listDrafts`, `loadDraft`, `deleteDraft`.

- [ ] **Step 1: Écrire le test**

```ts
const id = await saveDraft({ name: 'Yassin', selection: [{ surah: 36, verse: 1 }], settings });
expect((await listDrafts())[0].name).toBe('Yassin');
await saveDraft({ ...draft, id, name: 'Yassin 2' });
expect(await listDrafts()).toHaveLength(1);          // mise à jour, pas doublon
await deleteDraft(id);
expect(await listDrafts()).toHaveLength(0);
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Implémenter** sur IndexedDB (`idb`), tri par `updatedAt` décroissant.

- [ ] **Step 4: Relancer** → PASS.

- [ ] **Step 5: Commit** — `feat: add project drafts`

---

# Lot 3 — Moteur de rendu

### Task 16: Construction de la timeline

**Files:**
- Create: `packages/core/src/timeline.ts`
- Test: `packages/core/test/timeline.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces:

```ts
export interface TimelineEntry { clipIndex: number; start: number; end: number; }
export interface Timeline { entries: TimelineEntry[]; totalSec: number; }
export function buildTimeline(
  durationsSec: number[],
  opts?: { leadInMs?: number; gapMs?: number }   // défauts 800 et 300
): Timeline;
export function entryAt(timeline: Timeline, t: number): TimelineEntry | null;
export function exceedsLimit(durationsSec: number[], limitSec?: number): boolean;  // défaut 900
```

- [ ] **Step 1: Écrire le test**

```ts
const tl = buildTimeline([2, 3]);
expect(tl.entries).toEqual([
  { clipIndex: 0, start: 0.8, end: 2.8 },
  { clipIndex: 1, start: 3.1, end: 6.1 },
]);
expect(tl.totalSec).toBeCloseTo(6.1, 3);
expect(entryAt(tl, 0.2)).toBeNull();                 // pendant le silence initial
expect(entryAt(tl, 1.0)).toEqual({ clipIndex: 0, start: 0.8, end: 2.8 });
expect(entryAt(tl, 99)).toBeNull();
expect(exceedsLimit(new Array(600).fill(1))).toBe(true);   // 600 s + silences > 900
expect(exceedsLimit([2, 3])).toBe(false);
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Implémenter** sans flottants cumulés : les bornes sont calculées depuis une somme en millisecondes entières, puis divisées.

- [ ] **Step 4: Relancer** → PASS.

- [ ] **Step 5: Commit** — `feat: add deterministic timeline builder`

---

### Task 17: Répartition mot par mot

**Files:**
- Create: `packages/core/src/word-timing.ts`
- Test: `packages/core/test/word-timing.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces: `allocateWordTimings(words: string[], start: number, durationSec: number): { word: string; start: number; end: number }[]`.

- [ ] **Step 1: Écrire le test**

```ts
const w = allocateWordTimings(['بِسْمِ', 'اللَّهِ', 'الرَّحْمَٰنِ'], 10, 3);
expect(w).toHaveLength(3);
expect(w[0].start).toBe(10);
expect(w[2].end).toBeCloseTo(13, 5);
expect(w[1].start).toBeCloseTo(w[0].end, 5);              // continuité
expect(w[1].end - w[1].start).toBeGreaterThan(w[0].end - w[0].start); // mot plus long = plus de temps
expect(allocateWordTimings([], 0, 5)).toEqual([]);
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Implémenter**

Poids = nombre de caractères hors diacritiques (`/[\u064B-\u065F\u0670]/g`). Minimum 120 ms par mot, le reliquat est réparti au prorata. Le dernier mot absorbe l'erreur d'arrondi.

- [ ] **Step 4: Relancer** → PASS.

- [ ] **Step 5: Commit** — `feat: add word-level timing allocation`

---

### Task 18: Mise en page du texte arabe

**Files:**
- Create: `packages/render/src/text-layout.ts`
- Test: `packages/render/test/text-layout.test.ts`

**Interfaces:**
- Consumes: `SubtitleStyle` (Task 11).
- Produces:

```ts
export interface LaidOutText { lines: string[]; lineHeight: number; totalHeight: number; }
export function layoutArabic(text: string, ctx: OffscreenCanvasRenderingContext2D,
  style: SubtitleStyle, maxWidth: number): LaidOutText;
export function layoutTranslation(text: string, …): LaidOutText;
```

- [ ] **Step 1: Écrire le test**

```ts
const ctx = fakeCtx({ measureText: (s) => ({ width: s.length * 20 }) });
const longest = 'لَا يُكَلِّفُ اللَّهُ نَفْسًا إِلَّا وُسْعَهَا …'; // 2:286 complet en fixture
const r = layoutArabic(longest, ctx, style, 900);
expect(r.lines.length).toBeGreaterThan(2);
expect(r.lines.every(l => ctx.measureText(l).width <= 900)).toBe(true);
expect(r.totalHeight).toBe(r.lines.length * r.lineHeight);
expect(layoutArabic('', ctx, style, 900).lines).toEqual([]);
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Implémenter**

Découpe par mots sur les espaces, mesure cumulative, passage à la ligne avant dépassement. `ctx.direction = 'rtl'` et `ctx.textAlign = 'center'`. Aucun découpage à l'intérieur d'un mot.

- [ ] **Step 4: Relancer** → PASS.

- [ ] **Step 5: Commit** — `feat: add arabic text layout with word wrapping`

---

### Task 19: Compositeur d'image

**Files:**
- Create: `packages/render/src/compositor.ts`, `packages/render/src/types.ts`
- Test: `packages/render/test/compositor.test.ts`

**Interfaces:**
- Consumes: `BackgroundPainter` (Task 12), `Timeline` (Task 16), `layoutArabic` (Task 18).
- Produces:

```ts
export class Compositor {
  constructor(canvas: OffscreenCanvas, style: SubtitleStyle, background: BackgroundPainter);
  prepare(verses: PreparedVerse[]): void;   // calcul des mises en page, une seule fois
  drawAt(t: number): void;
  dispose(): void;
}
export interface PreparedVerse {
  arabic: string; translation: string;
  words: { word: string; start: number; end: number }[] | null;  // null = mode verset
}
```

- [ ] **Step 1: Écrire le test**

```ts
const c = new Compositor(canvas, style, painter);
c.prepare([{ arabic: 'بِسْمِ اللَّهِ', translation: 'Au nom de Dieu', words: null }]);
c.drawAt(0.2);                                    // silence initial
expect(pixelAt(canvas, 540, 900)).toEqual(BACKGROUND_PIXEL);
c.drawAt(1.5);
expect(pixelAt(canvas, 540, 500)).not.toEqual(BACKGROUND_PIXEL);  // du texte est dessiné
c.dispose();
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Implémenter**

Ordre de dessin : fond → voile → arabe → traduction → filigrane. En mode mot par mot, le mot courant est dessiné avec la couleur d'accent et les autres avec la couleur atténuée ; **les mises en page sont calculées dans `prepare`, jamais dans `drawAt`** — c'est la principale optimisation du rendu.

- [ ] **Step 4: Relancer** → PASS.

- [ ] **Step 5: Commit** — `feat: add frame compositor with cached text layout`

---

### Task 20: Écriture de sortie (mémoire, OPFS, File System Access)

**Files:**
- Create: `packages/render/src/sink.ts`
- Test: `packages/render/test/sink.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces:

```ts
export interface OutputSink {
  write(chunk: Uint8Array): Promise<void>;
  finalize(): Promise<Blob>;
  abort(): Promise<void>;
  readonly bytesWritten: number;
}
export function createSink(kind: 'memory' | 'opfs' | 'fs-access', name: string): Promise<OutputSink>;
export function pickSinkKind(maxBytes: number, caps: { opfs: boolean; fsAccess: boolean }): 'memory' | 'opfs' | 'fs-access';
```

- [ ] **Step 1: Écrire le test**

```ts
expect(pickSinkKind(50_000_000, { opfs: true, fsAccess: true })).toBe('fs-access');
expect(pickSinkKind(50_000_000, { opfs: true, fsAccess: false })).toBe('opfs');
expect(pickSinkKind(10_000_000, { opfs: false, fsAccess: false })).toBe('memory');
expect(pickSinkKind(900_000_000, { opfs: false, fsAccess: false })).toBe('fs-access'); // fallback documenté

const sink = await createSink('memory', 'test');
await sink.write(new Uint8Array([1, 2, 3]));
expect(sink.bytesWritten).toBe(3);
expect(await (await sink.finalize()).arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Implémenter**

Seuil mémoire : 64 Mo. Au-delà, OPFS ou File System Access. `abort()` supprime le fichier partiel. Une erreur de quota (`QuotaExceededError`) est traduite en `StorageQuotaError` typée (Review Focus n°3).

- [ ] **Step 4: Relancer** → PASS.

- [ ] **Step 5: Commit** — `feat: add streaming output sinks with quota handling`

---

### Task 21: Encodeur WebCodecs (chemin nominal)

**Files:**
- Create: `packages/render/src/encoder-webcodecs.ts`, `packages/render/src/muxer.ts`
- Test: `packages/render/test/encoder-webcodecs.test.ts`

**Interfaces:**
- Consumes: `Compositor` (Task 19), `OutputSink` (Task 20), `buildTimeline` (Task 16).
- Produces: `encodeWebCodecs(plan: EncodePlan, sink: OutputSink, onProgress): Promise<RenderedVideo>` avec `RenderSpec` de la spec §6.3.

- [ ] **Step 1: Écrire le test d'intégration (Chromium headless)**

```ts
const result = await encodeWebCodecs(plan3Verses, sink, () => {});
const bytes = new Uint8Array(await (await sink.finalize()).arrayBuffer());
expect(new TextDecoder().decode(bytes.slice(4, 8))).toBe('ftyp');       // conteneur MP4
expect(result.durationSec).toBeCloseTo(plan3Verses.timeline.totalSec, 1);
expect(result.width).toBe(1080);
expect(result.videoCodec).toBe('avc1');
expect(bytes.length).toBeGreaterThan(50_000);
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Implémenter avec les décisions de performance**

- Config vidéo : `hardwareAcceleration: 'prefer-hardware'`, `latencyMode: 'quality'`, bitrate 6 Mbps en 1080p, 3,5 Mbps en 720p.
- Horodatage **déterministe** `i * 1_000_000 / fps` en microsecondes.
- Contre-pression : attendre tant que `encoder.encodeQueueSize > 8`.
- Lot de 60 images puis `await new Promise(r => setTimeout(r, 0))` pour ne pas bloquer la boucle d'événements.
- Audio : `AudioEncoder` AAC 128 kbps, alimenté par les `AudioBuffer` de la timeline, un `AudioData` par verset.
- MP4 fragmenté si `sink` n'est pas mémoire.

- [ ] **Step 4: Relancer** → PASS. Mesurer et consigner le débit (`frames / elapsed`) dans le rapport de test.

- [ ] **Step 5: Commit** — `feat: add webcodecs mp4 encoder`

---

### Task 22: Repli MediaRecorder

**Files:**
- Create: `packages/render/src/encoder-mediarecorder.ts`, `packages/render/src/select-encoder.ts`
- Test: `packages/render/test/encoder-fallback.test.ts`

**Interfaces:**
- Consumes: `Compositor`, `OutputSink`.
- Produces: `selectEncoder(caps: { webCodecs: boolean; mediaRecorder: boolean }): 'webcodecs' | 'mediarecorder' | 'none'`.

- [ ] **Step 1: Écrire le test**

```ts
expect(selectEncoder({ webCodecs: true, mediaRecorder: true })).toBe('webcodecs');
expect(selectEncoder({ webCodecs: false, mediaRecorder: true })).toBe('mediarecorder');
expect(selectEncoder({ webCodecs: false, mediaRecorder: false })).toBe('none');
```

```ts
const result = await encodeMediaRecorder(planShort, sink, () => {});
expect(result.container).toBeOneOf(['mp4', 'webm']);     // annoncé, jamais supposé
expect(result.durationSec).toBeCloseTo(planShort.timeline.totalSec, 1);
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Implémenter**

`canvas.captureStream(fps)` + `MediaStreamAudioDestinationNode`, rendu en temps réel piloté par `requestAnimationFrame`. Le conteneur réellement obtenu est lu depuis `recorder.mimeType` et affiché à l'utilisateur.

- [ ] **Step 4: Relancer** → PASS.

- [ ] **Step 5: Commit** — `feat: add mediarecorder fallback encoder`

---

### Task 23: Vidéo de fond décodée image par image

**Files:**
- Create: `packages/render/src/background-video.ts`
- Test: `packages/render/test/background-video.test.ts`

**Interfaces:**
- Consumes: `BackgroundPainter` (Task 12).
- Produces: `createVideoPainter(file: Blob, size: Size, durationSec: number): Promise<BackgroundPainter>`.

- [ ] **Step 1: Écrire le test**

```ts
const painter = await createVideoPainter(mp4H264Fixture, { width: 1080, height: 1920 }, 4);
expect(painter.ready).toBe(true);
painter.paint(ctx, 0);   const a = pixelAt(canvas, 10, 10);
painter.paint(ctx, 2);   const b = pixelAt(canvas, 10, 10);
expect(a).not.toBe(b);                              // l'image change avec t
await expect(createVideoPainter(hevcFixture, size, 4)).rejects.toThrow(/codec/);
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Implémenter**

Démuxage MP4 via `mp4box`, alimentation d'un `VideoDecoder`, cache des `VideoFrame` récents (fenêtre de 30 images) pour éviter de redécoder en arrière. Bouclage de la source sur la durée demandée. Rejet explicite si le codec n'est pas H.264 (Review Focus n°4).

- [ ] **Step 4: Relancer** → PASS.

- [ ] **Step 5: Commit** — `feat: add frame-accurate background video decoding`

---

### Task 24: Orchestrateur dans un Worker

**Files:**
- Create: `packages/render/src/worker.ts`, `packages/render/src/index.ts`
- Test: `packages/render/test/worker.test.ts`

**Interfaces:**
- Consumes: Tasks 19–23.
- Produces:

```ts
export interface RenderedVideo { blob: Blob; durationSec: number; width: number; height: number;
  container: 'mp4' | 'webm'; videoCodec: string; }
export interface Progress { frame: number; totalFrames: number; percent: number; etaSec: number; }
export interface VideoRenderer {
  render(spec: RenderSpec, onProgress: (p: Progress) => void): Promise<RenderedVideo>;
  cancel(): void;
}
export function createRenderer(): VideoRenderer;
```

- [ ] **Step 1: Écrire le test**

```ts
const renderer = createRenderer();
const progress: number[] = [];
const promise = renderer.render(plan, (p) => progress.push(p.percent));
await promise;
expect(progress[0]).toBeLessThanOrEqual(1);
expect(progress.at(-1)).toBe(100);
expect(progress.every((p, i) => i === 0 || p >= progress[i - 1])).toBe(true);   // monotone
```

Test d'annulation :

```ts
const p = renderer.render(planLong, () => {});
setTimeout(() => renderer.cancel(), 200);
await expect(p).rejects.toThrow(/cancel/);
expect(await listPartialFiles()).toHaveLength(0);      // aucun fichier partiel laissé
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Implémenter**

`new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`, canvas transféré par `transferControlToOffscreen()`. Le rendu de 15 min tourne **hors du thread principal** : c'est ce qui garantit le budget « interface jamais bloquée > 50 ms ». Vérification de la limite de 900 s avant de démarrer.

- [ ] **Step 4: Relancer** → PASS.

- [ ] **Step 5: Commit** — `feat: add worker-based renderer orchestrator`

---

### Task 25: File de rendu persistée

**Files:**
- Create: `packages/render/src/queue.ts`, `apps/web/src/lib/queue-store.ts`
- Test: `packages/render/test/queue.test.ts`

**Interfaces:**
- Consumes: `VideoRenderer` (Task 24).
- Produces: `interface RenderJob { id: string; spec: RenderSpec; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; progress: number; error?: string }` ; `enqueue`, `runNext`, `cancelJob`, `listJobs`.

- [ ] **Step 1: Écrire le test**

```ts
await enqueue(jobA); await enqueue(jobB);
await runNext(fakeRenderer);
expect((await listJobs()).map(j => j.status)).toEqual(['done', 'queued']);
await runNext(fakeRenderer);
expect((await listJobs()).map(j => j.status)).toEqual(['done', 'done']);
```

```ts
await enqueue(jobLong); const p = runNext(renderer); await cancelJob(jobLong.id); await p;
expect((await listJobs()).find(j => j.id === jobLong.id)!.status).toBe('cancelled');
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Implémenter**

Une seule tâche à la fois. Un job `running` retrouvé au démarrage passe à `failed` avec la raison « interrompu » (relance depuis le début, décision de la spec §6.5) et l'UI propose de relancer.

- [ ] **Step 4: Relancer** → PASS.

- [ ] **Step 5: Commit** — `feat: add persistent render queue`

---

# Lot 4 — Résultat

### Task 26: Page de résultat

**Files:**
- Create: `apps/web/app/rendu/[id]/page.tsx`, `apps/web/src/components/ResultPlayer.tsx`
- Test: `apps/web/test/rendu.test.tsx`

**Interfaces:**
- Consumes: `RenderJob` (Task 25).
- Produces: `/rendu/{id}` affiche trois états distincts : `running` (progression), `done` (lecteur + téléchargement), `failed` (message + relancer).

- [ ] **Step 1: Écrire le test**

```tsx
render(<RenduPage job={{ ...job, status: 'failed', error: 'codec' }} />);
expect(screen.getByText(/codec/i)).toBeInTheDocument();
expect(screen.queryByRole('video')).not.toBeInTheDocument();

render(<RenduPage job={{ ...job, status: 'done' }} />);
expect(screen.getByRole('video')).toBeInTheDocument();
expect(screen.getByRole('link', { name: /Télécharger/ })).toHaveAttribute('download');
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Implémenter**

Un job inconnu affiche un 404 réel (`notFound()`), jamais « Vidéo prête ». C'est la correction du défaut le plus grave de l'application d'origine.

- [ ] **Step 4: Relancer** → PASS.

- [ ] **Step 5: Commit** — `feat: add result page with honest job states`

---

### Task 27: Historique et rétention

**Files:**
- Create: `apps/web/src/lib/history.ts`, `apps/web/src/components/HistoryList.tsx`
- Test: `apps/web/test/history.test.ts`

**Interfaces:**
- Consumes: `RenderedVideo` (Task 24).
- Produces: `addToHistory(entry)`, `listHistory()`, `deleteFromHistory(id)`, `enforceRetention(max = 3)`.

- [ ] **Step 1: Écrire le test**

```ts
for (let i = 0; i < 5; i++) await addToHistory({ id: `v${i}`, createdAt: i, size: 1000, video });
expect(await listHistory()).toHaveLength(3);
expect((await listHistory()).map(e => e.id)).toEqual(['v4', 'v3', 'v2']);
await deleteFromHistory('v4');
expect(await listHistory()).toHaveLength(2);
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Implémenter**

Rétention de 3, tri par date décroissante, suppression du blob en même temps que l'entrée. Un `StorageQuotaError` pendant l'écriture déclenche la purge de l'entrée la plus ancienne puis une nouvelle tentative, une seule fois.

- [ ] **Step 4: Relancer** → PASS.

- [ ] **Step 5: Commit** — `feat: add render history with retention`

---

### Task 28: Partage

**Files:**
- Create: `apps/web/src/lib/share.ts`, `apps/web/src/components/ShareButton.tsx`
- Test: `apps/web/test/share.test.ts`

**Interfaces:**
- Consumes: `RenderedVideo`.
- Produces: `shareVideo(file: File, title: string): Promise<'shared' | 'downloaded' | 'cancelled'>`.

- [ ] **Step 1: Écrire le test**

```ts
expect(await shareVideo(file, 'Yassin', { canShare: true })).toBe('shared');
expect(await shareVideo(file, 'Yassin', { canShare: false })).toBe('downloaded');
expect(await shareVideo(file, 'Yassin', { canShare: true, shareThrows: 'AbortError' })).toBe('cancelled');
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Implémenter**

`navigator.canShare({ files })` quand disponible, sinon téléchargement. `AbortError` = annulation utilisateur, pas une erreur affichée. Sur Electron, le partage système est remplacé par « révéler dans le dossier » (branchement au plan d'empaquetage).

- [ ] **Step 4: Relancer** → PASS.

- [ ] **Step 5: Commit** — `feat: add native share with download fallback`

---

# Lot 5 — Web publiable

### Task 29: Métadonnées et indexation

**Files:**
- Create: `apps/web/src/lib/metadata.ts`, `apps/web/app/sitemap.ts`, `apps/web/app/robots.ts`
- Modify: `apps/web/app/sourate/[id]/page.tsx`, `apps/web/app/layout.tsx`
- Test: `apps/web/test/metadata.test.ts`

**Interfaces:**
- Consumes: `SurahMeta` (Task 2).
- Produces: `buildSurahMetadata(surah: SurahMeta, baseUrl: string): Metadata`.

- [ ] **Step 1: Écrire le test**

```ts
const m = buildSurahMetadata(surah36, 'https://quran.example');
expect(m.title).toContain('Yâ-Sîn');
expect(m.description).toMatch(/récitation/i);
expect(m.alternates?.canonical).toBe('https://quran.example/sourate/36');
expect(m.openGraph?.title).toContain('Yâ-Sîn');
```

```ts
expect(sitemap().length).toBe(115);                  // accueil + 114 sourates
expect(robots().rules).toContainEqual({ userAgent: '*', allow: '/' });
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Implémenter**

Titres individuels, descriptions **en français**, OG et Twitter, canonical absolu construit depuis `NEXT_PUBLIC_SITE_URL`. La page `/` redirige **côté serveur** (`redirect()`).

- [ ] **Step 4: Relancer** → PASS. Vérifier dans `out/sourate/36/index.html` la présence du `<h1>` et du texte des versets.

- [ ] **Step 5: Commit** — `feat: add per-surah metadata, sitemap and robots`

---

### Task 30: En-têtes de sécurité

**Files:**
- Create: `apps/web/vercel.json`, `apps/web/next.config.ts` (modify)
- Test: `apps/web/test/headers.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces: CSP, HSTS, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff`, `Permissions-Policy`.

- [ ] **Step 1: Écrire le test**

```ts
const h = buildHeaders();
expect(h['Content-Security-Policy']).toContain("default-src 'self'");
expect(h['Content-Security-Policy']).toContain('https://everyayah.com');
expect(h['Content-Security-Policy']).toContain("media-src 'self' blob: https://everyayah.com");
expect(h['Strict-Transport-Security']).toContain('max-age=31536000');
expect(h['X-Frame-Options']).toBe('DENY');
expect(h['X-Content-Type-Options']).toBe('nosniff');
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Implémenter**

`buildHeaders()` est la source unique, réutilisée par `vercel.json` et par la CSP d'Electron (plan d'empaquetage).

- [ ] **Step 4: Relancer** → PASS.

- [ ] **Step 5: Commit** — `feat: add security headers`

---

### Task 31: Passe d'accessibilité et budget de performance

**Files:**
- Create: `apps/web/test/a11y.test.tsx`, `apps/web/test/performance.test.tsx`
- Modify: `apps/web/app/globals.css`, `apps/web/src/components/**`

**Interfaces:**
- Consumes: toutes les pages.
- Produces: zéro violation `axe`, budget DOM respecté sur les deux pages principales.

- [ ] **Step 1: Écrire le test**

```tsx
for (const page of ['/bibliotheque', '/sourate/2', '/studio']) {
  const { container } = renderRoute(page);
  expect(await axe(container)).toHaveNoViolations();
  expect(container.querySelectorAll('*').length).toBeLessThan(2000);
  expect(container.querySelector('main')).toBeInTheDocument();
}
```

```ts
expect(contrastRatio('#a1a1a1', '#0a0a0a')).toBeGreaterThanOrEqual(4.5);
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Corriger**

Remplacer les jetons `text-white/40` par un équivalent ≥ 4.5:1, ajouter `<main>`, associer tous les labels, gérer le focus des modales, respecter `prefers-reduced-motion`.

- [ ] **Step 4: Relancer** → PASS.

- [ ] **Step 5: Commit** — `feat: meet wcag aa and dom budget`

---

### Task 32: Vérification de bout en bout

**Files:**
- Create: `apps/web/e2e/render.spec.ts`, `playwright.config.ts`
- Test: `apps/web/e2e/render.spec.ts`

**Interfaces:**
- Consumes: tout le parcours.
- Produces: preuve que le produit fonctionne de bout en bout.

- [ ] **Step 1: Écrire le test Playwright**

```ts
test('parcours complet : 3 versets → MP4', async ({ page }) => {
  await page.goto('/bibliotheque');
  await page.getByLabel('Rechercher une sourate').fill('yassin');
  await page.getByRole('link', { name: /Yâ-Sîn/ }).click();
  await page.getByLabel('Sélectionner le verset 1').check();
  await page.getByLabel('Sélectionner le verset 2').check();
  await page.getByLabel('Sélectionner le verset 3').check();
  await page.getByRole('button', { name: /Studio/ }).click();
  await page.getByLabel('Format 9:16').check();
  await page.getByRole('button', { name: /Générer/ }).click();
  await expect(page.getByText(/100\s?%/)).toBeVisible({ timeout: 120_000 });
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: /Télécharger/ }).click();
  const file = await (await download).path();
  const head = await readFirstBytes(file, 12);
  expect(head.toString('ascii', 4, 8)).toBe('ftyp');
});
```

- [ ] **Step 2: Lancer, voir échouer.**

- [ ] **Step 3: Corriger ce que le parcours révèle**

Ce test est le juge de paix : s'il passe, la v1 fonctionne.

- [ ] **Step 4: Relancer sur Chromium, puis sur WebKit** (chemin de repli MediaRecorder)

Run: `npx playwright test`

- [ ] **Step 5: Commit** — `test: add end-to-end render pipeline check`

---

## Auto-évaluation du plan

**Couverture de la spec** — §6.1 dépôt : T1. §6.2 données : T3–T6. §6.3 rendu : T12, T16–T25. §6.4 persistance : T10, T15, T27. §6.5 état/reprise : T25. §7 fonctionnalités : T7–T15, T26–T28. §8 qualité : T31, T32, T29, T30. §9 légal : attribution en T3/T4, page `/a-propos` livrée en T29. §11 lots 1–5 : intégralement couverts. Les lots 6–7 (Android, Windows) font l'objet d'un plan séparé, conformément au découpage en sous-projets.

**Cohérence des types** — `VerseRef`, `StudioSettings`, `RenderSpec`, `OutputSink`, `RenderedVideo`, `RenderJob`, `Timeline` sont définis une fois (T2, T10, T16, T20, T24, T25) et réutilisés sans renommage.

**Review Focus** — n°1 : test de débordement en T18. n°2 : test d'échec nommant le verset en T6 et T21. n°3 : `StorageQuotaError` en T20 et T27. n°4 : refus de codec en T13 et T23. n°5 : état vide désactivé en T11.
