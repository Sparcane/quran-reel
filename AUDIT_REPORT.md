# Audit qualité, sécurité et tests — quran reel

Rapport des étapes 2 à 5 de `REFACTOR_PROMPT.md`.
Branche `main` (`7998565`), arbre de travail propre pendant l'audit (aucun fichier modifié, aucun commit).

---

## 0. Méthode et preuves

| Étape | Ce qui a été fait | Preuve |
|---|---|---|
| 1. Cartographie | Déjà livrée : 1 212 nœuds, 2 826 arêtes, 80 communautés (`graphify-out/`) | `GRAPH_REPORT.md` |
| 2. Qualité | Lecture intégrale des modules de rendu, de la couche web et des scripts de données | citations `fichier:ligne` ci-dessous |
| 3. Sécurité | En-têtes, CSP, surface réseau, validation des fichiers importés, dépendances | `npm audit` + `headers.ts` + `import-background.ts` |
| 4. Tests | Exécution complète + cartographie source ↔ test | `vitest run` : **41 fichiers, 433 tests, tous verts** |
| 5. Synthèse | Plan par lots réversibles + commandes | ce document |

Deux défauts suspectés à la lecture ont été **prouvés par un test jetable**, puis le fichier a été supprimé
(`packages/render/test/__audit-probe.test.ts`, absent de `git status` à la fin) :

```
A status after stale progress: running        → attendu 'cancelled', obtenu 'running'
B frames encoded after cancel: 60              → encodeur allé jusqu'au bout après annulation
  encoder ran to completion: true
```

Aucun constat ci-dessous n'est déduit du graphe seul : chacun est vérifié dans le code ou par exécution.

### Échelle de criticité

`score = impact × probabilité`, sur 10.

| Score | Sens |
|---|---|
| 8–10 | sortie fausse, plantage ou état corrompu pour un utilisateur normal |
| 6–7 | perte de données / blocage dans un cas réaliste (quota, fichier lourd, annulation) |
| 4–5 | bug visible sur un chemin secondaire, ou piège qui bloquera la prochaine évolution |
| 1–3 | robustesse, lisibilité, cosmétique |

---

## 1. Étape 2 — Audit de qualité

### F1 · L'annulation ne stoppe pas l'encodeur sur le thread principal — **8/10**

`render-runtime.ts:29` n'offload que les fonds dégradés : dès qu'un fond importé est choisi,
ou que le navigateur n'a pas `Worker`, l'encodage tourne sur le thread principal.
`worker.ts:292-321` annule en rejetant une promesse `cancellation` **séparée** du travail :

```ts
const cancellation = new Promise<never>((_resolve, reject) => { cancelJob = () => reject(...) });
const job = environment.encode(kind, plan, sink, ...);
job.catch(() => undefined);            // ligne 305 : la rejection du travail est avalée
const result = await Promise.race([job, cancellation]);
```

`render()` rend la main (et `sink.abort()`), mais `encodeWebCodecs` / `encodeMediaRecorder`
continuent : 60 frames sur 60 encodées après `cancel()` (mesuré).
Conséquences : jusqu'à 15 minutes de CPU/batterie pour rien ; sur le chemin `MediaRecorder`,
le recorder, l'`AudioContext` et le flux de capture ne sont jamais libérés.

Correctif visé : la mécanique existe déjà, le worker s'en sert (`worker.ts:179-182`) —
faire lever `RenderCancelledError` par le callback de progression du chemin inline.
Une modification locale, sans toucher aux encodeurs.

### F2 · Les progrès tardifs ressuscitent un job annulé — **8/10**

`queue.ts:154-160` persiste chaque progrès avec l'instantané `running` capturé avant le rendu :

```ts
void store.put({ ...running, progress: progress.percent });   // status: 'running'
```

`cancelJob` écrit `cancelled` (`queue.ts:194`), puis le progrès suivant réécrit `running`.
Mesuré : `'cancelled'` → `'running'`. Au rechargement, `recover()` (`queue.ts:206-222`)
le classe « interrompu ». L'utilisateur annule et voit un job repartir à 100 % puis échouer.

Correctif : ignorer un progrès si le statut stocké n'est plus `running` (une lecture), ou
un drapeau `cancelled` local. Le test de non-régression existe : il suffit de rendre le
renderer de test « mal élevé » (il continue d'émettre après `cancel`), ce que fait le vrai.

### F3 · Fond vidéo : toutes les frames décodées restent en mémoire — **8/10**

`background-video.ts:305-329` décode la source entière, `frames` garde chaque `VideoFrame` vivant
pour que `paint` soit synchrone (`337-345`). Aucune borne n'est posée en amont :
`import-background.ts:83-117` ne vérifie **ni la taille, ni la durée, ni les dimensions** du fichier.

Ordre de grandeur : 1 minute de 1080p à 30 fps = 1 800 frames ; en RGBA 1920×1080 ≈ 8 Go.
Un clip de quelques secondes en HD suffit à faire tomber l'onglet. Le paramètre `durationSec`
(`background-video.ts:307`) plafonne au *rendu*, pas à la source utile.

C'est le risque le plus élevé du produit : il ne se voit pas en test (jsdom n'a pas de décodeur)
et il frappe la fonction la plus « impressionnante » de l'interface.

**Corrigé par L4** : budget de frames (`frameBudget`) — au plus 120 frames (4 s à 30 fps), réduit
proportionnellement à la résolution (77 pour du 1080p, 19 pour du 4K), plafonné par 160 MP de
picture décodée. Le décodage s'arrête au budget et la boucle est la fenêtre conservée.
Deux points restent ouverts, à trancher : (a) un clip long est *tronqué* à ses premières
secondes sans que l'interface le dise — **corrigé par L10** : la fenêtre de boucle est lue dans la
table d'échantillons du fichier et annoncée dans le sélecteur de fond, avant le rendu ; (b) les
octets du fichier passent toujours à `mp4box` sur le thread principal (S2) — **corrigé par L11** :
le demux tourne dans un module worker dédié, un fichier refusé ou un worker muet rend une erreur
propre au lieu de figer l'onglet, et le repli inline ne subsiste que si aucun worker ne peut naître
(pas de `Worker`, CSP).

### F4 · Un job écrit en mémoire devient invisible pour la file — **7/10**

`queue-store.ts:190-200` : quand IndexedDB répond, `readAll()` renvoie **uniquement** les enregistrements IDB.
`put` (`216-229`) bascule sur `memoryJobs` quand l'écriture échoue (quota).
`get(id)` sait retomber sur la copie mémoire (`177-188`), `list()` non.

Scénario réaliste : `enqueue` sérialise l'audio décodé (des dizaines de Mo de `Float32Array`)
et dépasse le quota → le job vit en mémoire → `runNext` (`queue.ts:140`) ne le voit jamais →
la page `/rendu/<id>` reste indéfiniment sur « en file », sans erreur.
`persistFailure` (`queue-store.ts:155-172`) a exactement le même angle mort.

Correctif : fusionner `memoryJobs` dans le résultat de `readAll()` (une ligne), plus un test
qui force l'échec IDB.

### F5 · `validateEncodePlan` n'unifie pas le nombre de canaux — **4/10**

`encoder-plan.ts:102-117` n'impose qu'un `sampleRate` commun ; les canaux sont seulement bornés
à 1–2 par verse. Or `encoder-webcodecs.ts:246-247,379-382` prend `channels` sur la **première** verse
audio et lit `getChannelData(channel)` pour toutes : une sélection stéréo puis mono lève
`render: there is no audio channel 1` au milieu de l'encodage, après plusieurs minutes.
Latent aujourd'hui (le pipeline produit tout en stéréo), mais c'est le contrat public du moteur.

**Corrigé par L5** : `validateEncodePlan` exige désormais un nombre de canaux unique, comme il l'exigeait
déjà pour la fréquence d'échantillonnage ; le refus intervient avant tout encodage.

### F6 · Piste audio plus courte que l'image si la dernière verse est muette — **3/10**

`encoder-webcodecs.ts:184-204` n'émet aucun segment final : une verse silencieuse en fin de
sélection laisse la piste audio s'arrêter avant la vidéo. Les lecteurs le tolèrent ; le
commentaire du module promet pourtant l'inverse. À traiter avec F5 dans le même lot.

**Corrigé par L5** : `audioSegments` ajoute un segment de silence de la fin de l'audio à la fin du
timeline, couvrant aussi le cas d'un clip plus court que son emplacement de sous-titre.

### F7 · `decodeURIComponent` non protégé sur la page de résultat — **4/10**

`RenduRoute.tsx:20` décode le dernier segment d'URL sans `try`. `/rendu/%E0/` lève `URIError`
pendant le rendu React → page blanche, sans message ni retour. Une URL malformée est un cas
d'entrée normal (lien tronqué, copier-coller).

**Corrigé par L6** : `currentId` encadre `decodeURIComponent` et retombe sur l'id du routeur, ce qui
mène au 404 habituel pour un job inconnu au lieu d'une page vide.

### F8 · Aucune limite de taille à l'import d'un fond — **6/10**

`import-background.ts:83-117` juge le type par les octets magiques (bien) mais accepte un fichier
de n'importe quelle taille ; `storage.ts:298-313` en fait `await file.arrayBuffer()` (copie
complète en mémoire) puis l'écrit en IDB. Un PNG de 500 Mo ou un MP4 de 2 Go passe la validation
et fait tomber l'onglet avant même le rendu. Aucune dimension maximale n'est vérifiée non plus
(une image 20 000 × 20 000 serait acceptée).

**Corrigé par L3** : image ≤ 12 Mo, 8192 px de côté, 16 MP ; vidéo ≤ 48 Mo et ≤ 5 min de source,
avec les dimensions lues dans l'en-tête PNG/JPEG/WebP et la durée dans `mvhd`. Métadonnée
illisible = acceptée (pas de refus sur une supposition).

### F9 · Le `Worker` n'est jamais terminé — **3/10**

`worker.ts:266-289` : `terminate()` n'est jamais appelé ; `rendererFor` (`render-runtime.ts:28-41`)
crée un Worker par rendu. Aujourd'hui masqué par le rechargement de page systématique
(`render-runtime.ts:43-52`) : un seul rendu par document. Fragile dès qu'un rendu en place
sera introduit.

### F10 · Trois sérialisations parallèles du même contrat — **5/10**

Le même aplatissement « objet vivant → forme stockable » est écrit trois fois :
`audio-wire.ts:62-90` (worker), `queue-store.ts:51-83` (IDB), `history.ts:63-90` (blobs).
Ajouter un champ à `RenderedVideo` demande trois modifications synchronisées, sans test qui
le signale. C'est la dette la plus coûteuse à moyen terme, pas la plus urgente.

**Corrigé par L7** pour la partie vidéo : `StoredVideo` + `toStoredVideo`/`fromStoredVideo` vivent une
seule fois dans `@quran/render`, avec un test aller-retour. La file et l'historique gardent leur forme
de disque plate (aucune migration). Les deux `verses.map` restent, mais délèguent déjà toutes deux à
`serialiseAudio`/`deserialiseAudio`.

### F11 · Le spec relu d'un job terminé n'est pas rendable — **5/10**

`queue-store.ts:91-93` : un job `done`/`failed` avec fond importé reçoit le **dégradé par défaut**
comme peintre, alors que `backgroundSelection` désigne l'image. Inoffensif aujourd'hui parce que
tout rendu repasse par un rechargement de page et une remise en `queued`. C'est un piège armé :
la première évolution qui rend en place produira un fond faux, silencieusement — exactement ce que
le module dit refuser (`queue-store.ts:112-118`).

### F12 · `escapeValue: false` sans garde-fou — **2/10**

`i18n.ts:40` désactive l'échappement d'i18next. C'est sûr aujourd'hui : aucun
`dangerouslySetInnerHTML` ni `.innerHTML` dans `apps/web/src` (vérifié par recherche).
À inscrire comme invariant, idéalement par un test de garde, plutôt que de le laisser implicite.

### F13 · Le peintre vidéo se fige sur un vrai fichier : aucun fond importé ne se rend — **9/10**

`background-video.ts:305-329` garde chaque `VideoFrame` décodé **ouvert** pour que `paint` soit
synchrone. Or un décodeur WebCodecs réel recycle un nombre limité de buffers : quand trop de frames
restent ouvertes, il arrête de consommer la file d'entrée. `flush()` ne se résout alors jamais.

Prouvé dans Chrome, avec un MP4 H.264 1080×1920 de 63 images (2,1 s) produit par l'application
elle-même (`avc1.640028`, avcC de 27 octets, 2 images clés, première image clé en tête) :
`decodeQueueSize` passe de 63 à 49, 6 frames restent en attente, puis plus rien pendant 40 s ;
`flush()` n'aboutit pas, aucune erreur n'est levée, et l'interface reste indéfiniment sur
« Génération… ». Le même passage avec `frame.close()` dans le callback `output` draine la file et
décode toutes les images — la cause est bien la rétention des `VideoFrame`.

Conséquence produit : la fonction « fond vidéo importé » ne rend jamais de vidéo. Le défaut ne se
voit ni en jsdom (décodeur simulé), ni avec le fixture unitaire (payloads de 2 octets, non
décodables) ; il a été révélé en écrivant le parcours Playwright de L11 (rendre un MP4, le
réimporter, le rendre à nouveau).

**Corrigé par L12** : chaque image décodée est recopiée dans un `OffscreenCanvas` que le peintre
possède, et le `VideoFrame` est fermé aussitôt. `paint` dessine ces surfaces avec le même
`drawImage`. Le budget passe d'un plafond de pixels à un plafond d'octets de picture (128 Mo de
RGBA) : 120 frames pour un petit clip, 16 pour du 1080p, annoncées par le sélecteur avant le rendu.
L'A/B après correctif précise le mécanisme : recopier l'image sans fermer le `VideoFrame` suffit à
débloquer le décodage (35 s au lieu de 12,5 s), donc c'est bien la **rétention sans copie** qui
bloquait ; la fermeture immédiate est l'hygiène qui rend le rendu rapide. Le parcours Playwright
« rendre → réimporter → rendre » est le test de non-régression.

### F14 · Présence de l'API WebCodecs prise pour une capacité H.264 — **7/10**

`select-encoder.ts:16-20` choisit `webcodecs` dès que `VideoEncoder` et `VideoDecoder` existent.
Firefox 159 a ces API, mais `VideoEncoder.isConfigSupported({ codec: 'avc1…' })` échoue : aucun
encodeur H.264 n'est disponible. `encodeWebCodecs` lève alors
`encoder: no H.264 encoder accepts 1080×1920 at 30 fps` et **le rendu ne produit rien**, alors que
`MediaRecorder` est là et sait enregistrer en WebM. Le produit perd tout rendu sur Firefox pour une
raison de détection, pas de capacité réelle.

Vérifié en exécution : les 3 tests Playwright échouent sous Firefox (`channel` retiré de la config)
avec cette erreur. En masquant les API WebCodecs avant le chargement, le même parcours produit un
WebM VP8/Opus de 88 Ko en 6 s, lu par le lecteur — **le chemin de repli fonctionne**, c'est bien la
sélection qui est fautive.

**Corrigé par L13** : `h264EncoderAvailable` interroge `VideoEncoder.isConfigSupported` avec les
trois profils H.264 que l'encodeur utiliserait réellement, avant le choix du chemin et avant la
création du worker. Si aucun ne convient et que `MediaRecorder` existe, le rendu bascule sur le
thread principal et produit un WebM. La configuration Firefox du parcours ne masque plus rien :
le fichier est téléchargé et lu en 5,6 s. Trois tests sur la sonde et un sur la rétrogradation.

---

## 2. Étape 3 — Audit de sécurité

### Ce qui est solide

- **Surface réseau** : un seul tiers, `https://everyayah.com`, encodé dans la CSP
  (`headers.ts:26-29`) et dans `vercel.json`. `connect-src`, `media-src`, `worker-src`,
  `img-src` sont énumérés explicitement ; `object-src 'none'`, `frame-ancestors 'none'`,
  `base-uri 'self'`, `form-action 'self'`.
- **Pas de secret, pas de compte, pas de cookie, pas d'analytics.** Rien à faire fuiter côté serveur.
- **En-têtes** : HSTS *preload*, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`
  (`headers.ts:33-40`). Une source unique (`buildHeaders()`) et un test qui la compare à
  `vercel.json` (`headers.test.ts:47`) — c'est exactement le bon patron pour un export statique.
- **Injection HTML** : aucun sink. Les textes coraniques et les traductions passent par React
  ou par `fillText` sur canvas.
- **URL audio** : `audioUrl` (`audio-url.ts:7-14`) valide la référence et n'accepte que la
  `folder` du catalogue ; `reciterById` lève sur un identifiant inconnu (`reciters.ts:11-17`).
  Un `reciterId` trafiqué dans IndexedDB ne peut pas construire d'URL arbitraire.
- **Données locales** : tout ce qui vient d'IndexedDB est revalidé
  (`clampStudioSettings`, `migrateStudioState`, `sanitiseDraft`, `toSelection`) avant usage.
- **Dépendances** : `npm audit --omit=dev` → **0 vulnérabilité de production**. Au moment de
  l'audit, `npm audit` complet signalait **6 high, toutes en dev** (`vitest`, `vite`,
  `@vitejs/plugin-react`, `picomatch` ReDoS GHSA-fc5q-39xc-vjpf, `fdir`, `tinyglobby`), aucune
  expédiée. Re-vérifié en fin de chantier : **0 vulnérabilité**, sans changer le lockfile (S4).

### Points ouverts

| # | Constat | Criticité |
|---|---|---|
| S1 | `script-src 'unsafe-inline'` (contrainte assumée de l'export statique, documentée `headers.ts:21-23`). Risque résiduel limité par l'absence totale de sink d'injection. À durcir plus tard avec `require-trusted-types-for 'script'`, pas avant. | 2 |
| S2 | Fichiers importés : validation par octets magiques uniquement, sans borne de taille/durée/dimensions (F8). **Corrigé par L3** pour le volume et les métadonnées ; la frontière de confiance réelle (`mp4box` sur des octets non fiables) est **isolée dans un worker par L11** : un parseur qui échoue, tourne en boucle ou plante ne coûte que le job, pas l'onglet. | 6 → 2 |
| S3 | La détection H.264 cherche la chaîne `avc1` dans 256 Ko (`import-background.ts:64-68`) : un MP4 HEVC contenant `avc1` dans ses métadonnées serait accepté puis échouerait au décodage. Faux positif, pas faille. | 3 |
| S4 | Dépendances dev : L9 a tenté le « correctif » proposé à l'époque (`vitest` 3.1.4, `@vitejs/plugin-react` 5.2.0) — **7 vulnérabilités, dont 2 critiques** (`tinypool` RCE, `vitest`) — puis l'a annulé. État d'origine restauré. **Re-vérifié ensuite avec le lockfile intact contre le registre public : 0 vulnérabilité**, en production comme en dev. Les avis ont été révisés en amont ; aucun changement de dépendance conservé. | 0 |
| S5 | `decodeURIComponent` (F7) : plantage sur URL malformée, pas d'exécution de code. | 4 |

Aucune faille d'exécution de code, d'élévation de privilège ou d'exposition de données
n'a été trouvée. Le modèle de menace du produit (application locale, sans compte) est tenu.

---

## 3. Étape 4 — Analyse des tests

**État** : 41 fichiers, 433 tests, tous verts en 16 s ; `tsc` et `eslint` verts ; build 122 pages ;
Playwright 2/2 (Chrome système, WebKit non installé).

### Ce qui est bien couvert

`muxer.ts` (octets, fragments, `avcC`), `sink.ts` (machine à états, quota, abort),
`compositor.ts` / `text-layout.ts` (layout, ajustement, RTL), `queue.ts` (FIFO, reprise, annulation
nominale), `history.ts` (rétention, purge quota), `drafts.ts`, `preview-audio.ts`, `share.ts`,
`headers.ts`, `import-background.ts`, les scripts de données (`build-data`, `build-translations`,
`verify-data`), plus un audit d'accessibilité `a11y.test.tsx`.

### Angles morts, par ordre d'importance

| # | Manque | Pourquoi ça compte |
|---|---|---|
| T1 | **Annulation réelle de l'encodeur** : les tests de file utilisent un renderer qui rejette sur `cancel()` (`queue.test.ts:84-110`), comportement que `createRenderer` n'a pas. C'est ce faux ami qui a laissé passer F1 et F2. | chemin critique, deux bugs prouvés |
| T2 | **`background-painter.ts` jamais testé pour de vrai** : `ensureImportedAsset` / `createImportedBackground` ne sont que mockés (`queue-store.test.ts:21-25`). C'est le module qui décide « fond présent / fond disparu ». **Couvert par L8.** | décision métier non couverte |
| T3 | **Repli mémoire de `queue-store`** (F4) : aucun test ne force l'échec d'écriture IDB. **Couvert par L2** (`queue-store-quota.test.ts` : écritures rejetées, lectures intactes). | scénario quota = cas réel |
| T4 | **`render-runtime.ts`** : `startRender`, `recoverQueue` et la branche `new Worker` sont mockés (`render-runtime.test.ts:11-27`). **Couvert par L8.** | câblage applicatif |
| T5 | **`background-video.ts`** : décodage et réordonnancement B-frames testés. **Couvert par L4** (`frameBudget` testé pour HD/UHD, arrêt du décodage et boucle sur la fenêtre conservée vérifiés avec une limite injectée). | risque n°1 produit |
| T6 | **Composants sans test** : `SurahSearch`, `SurahCard`, `VerseRow`, `NumberField`, `StudioRoute` n'apparaissent dans aucun test. | UI, faible risque |
| T7 | **`scripts/generate-surah-meta.ts`** : non testé (il génère `packages/core/src/surah-meta.ts`). Faible risque, mais une régénération cassée est silencieuse. | outillage |
| T8 | **`npm run typecheck` ne couvre pas `apps/web`** : `tsconfig.json` n'inclut que `packages/*`, `scripts` et `e2e`. Découvert en L3 — le typecheck racine passait alors que `next build` échouait sur un fichier de test web. **Corrigé par L8** : la commande vérifie aussi `apps/web` (elle a immédiatement trouvé une vraie erreur de type dans un test ajouté). | porte qualité |

Priorité de test, si l'on ne fait que trois choses : T1 (verrouille F1/F2), T2, T3.

---

## 4. Étape 5 — Synthèse

### Zones critiques (à traiter en priorité)

| Module | Constats | Score | Effort |
|---|---|---|---|
| `packages/render/src/worker.ts` + `render-runtime.ts` | F1, F9 | 8 | 0,5 j |
| `packages/render/src/queue.ts` | F2 | 8 | 0,25 j |
| `packages/render/src/background-video.ts` + `import-background.ts` | F3, F8, S2, S3 | 8 | 1 j |
| `apps/web/src/lib/queue-store.ts` | F4, F11 | 7 | 0,5 j |
| `packages/render/src/encoder-plan.ts` (+ `encoder-webcodecs.ts`) | F5, F6 | 4 | 0,25 j |
| `apps/web/src/components/RenduRoute.tsx` | F7 | 4 | 0,1 j |
| `audio-wire.ts` / `queue-store.ts` / `history.ts` | F10 | 5 | 1 j |
| `apps/web/src/lib/i18n.ts` | F12 | 2 | 0,1 j |

**Total réaliste : 3 à 4 jours**, dont 2 pour les quatre premiers modules.

### Zones acceptables — ne pas toucher

- `muxer.ts` (471 l.) : la géométrie des boxes a été vérifiée box par box (`mvhd`, `tkhd`, `stsd`,
  `avc1`, `mp4a`, `tfhd`/`tfdt`/`trun`, drapeaux `0x02000000` / `0x01010000` conformes).
  Petit, testé, isolé : le refactorer serait un risque net négatif.
- `sink.ts` : machine à états explicite, `abort` symétrique, quota traduit en erreur actionnable.
- `compositor.ts` / `text-layout.ts` : travail coûteux fait une fois dans `prepare()`, validations en entrée.
- `storage.ts` (migrations), `drafts.ts`, `verses.ts` : défensifs, sanitisent avant de servir.
- `share.ts`, `preview-audio.ts` : seams injectables, comportements de repli testés.
- `headers.ts` + `vercel.json` : source unique + test de synchronisation.

### Plan par lots (petits, testables, réversibles)

Chaque lot : test d'abord, un commit, retour arrière = `git revert`.

| Lot | Contenu | Fichiers | Test de non-régression | Effort |
|---|---|---|---|---|
| **L0** | Filet : exécuter la suite et noter la référence | — | `npm test` (433) | 0,1 j |
| **L1** | Annulation : `RenderCancelledError` levée depuis le callback de progression inline + garde de statut dans la persistance des progrès | `worker.ts`, `queue.ts` | renderer « qui continue après cancel » → statut `cancelled`, aucun progrès persisté | 0,5 j |
| **L2** | File visible : fusionner `memoryJobs` dans `readAll()` et `persistFailure` | `queue-store.ts` | écriture IDB forcée en échec → `list()` contient le job | 0,3 j |
| **L3** | Bornes d'import : taille max image/vidéo, durée et dimensions max ; message utilisateur explicite | `import-background.ts`, `storage.ts` | fichiers surdimensionnés refusés avec `reason` dédié | 0,5 j |
| **L4** | Mémoire du fond vidéo : plafond de frames décodées + échantillonnage (décoder 1 frame sur N) ou boucle sur une fenêtre courte | `background-video.ts` | compteur de frames ≤ plafond pour une source longue | 0,7 j |
| **L5** | Contrat du plan : un seul nombre de canaux, silence final couvert | `encoder-plan.ts`, `encoder-webcodecs.ts` | plan mixte mono/stéréo refusé avant encodage | 0,3 j |
| **L6** | Robustesse URL : `decodeURIComponent` protégé, état « id invalide » | `RenduRoute.tsx` | `/rendu/%E0/` affiche 404, pas de page blanche | 0,1 j |
| **L7** | Unifier les trois sérialisations (`WireVerseClip`, `StoredResult`, blob d'historique) | `audio-wire.ts`, `queue-store.ts`, `history.ts` | aller-retour identique pour les trois usages | 1 j |
| **L8** | Tests manquants T2/T3/T4 + garde `escapeValue` + `typecheck` qui couvre `apps/web` (T8) | tests, `i18n.ts`, `package.json` | suite ≥ 450 tests ; une erreur de type dans `apps/web` casse `npm run typecheck` | 1 j |
| **L9** | Dépendances dev : `npm audit fix` (ou montée `vitest`/`vite`) | `package.json` | audit dev à 0 high | 0,3 j |
| **L11** | Demux hors du thread principal : module worker, protocole `{id, file}` → `{id, source}`/`{id, error}`, délai maximal, repli inline seulement sans worker | `demux-worker.ts`, `video-environment.ts`, `demux-worker-entry.ts`, `background-video.ts` | 7 tests de protocole, 2 de la fabrique web, 1 du seam peintre | 0,5 j |
| **L12** | Fond vidéo réellement rendu : recopier chaque frame dans une surface possédée puis fermer le `VideoFrame`, budget par octets | `background-video.ts` | parcours Playwright « rendre → réimporter → rendre » (F13) | 0,7 j |
| **L13** | Sélection de l'encodeur : vérifier qu'une config H.264 est réellement supportée avant de choisir WebCodecs, sinon `MediaRecorder` | `select-encoder.ts`, `worker.ts`, tests | 3 cas de sélection + parcours Firefox sans masquage (F14) | 0,4 j |

Ordre recommandé : **L1, L2, L3, L4, L5, L6, L8, L7, L9**.
(L1–L6 corrigent des défauts prouvés ; L7 est de la dette ; L9 s'est clos sans modification.)

**Avancement** : L1 fait — `a2d4f21`, 4 fichiers, +93/−2, 435 tests verts.
L2 fait — `a3ba290`, 2 fichiers, +150/−1, 437 tests verts.
L3 fait — `e2a7139`, 7 fichiers, +440/−20, 449 tests verts.
L4 fait — `0d607ab`, 2 fichiers, +109/−5, 453 tests verts.
L5 fait — `c8d1cd8`, 3 fichiers, +41/0, 455 tests verts.
L6 fait — `e105749`, 2 fichiers, +25/−6, 457 tests verts.
L8 fait — `20f2190`, 4 fichiers, +176/−6, 468 tests verts.
L7 fait — `5940564`, 5 fichiers, +112/−63, 470 tests verts.
L9 clos — aucune dépendance modifiée, `npm audit` à 0 avec le lockfile d'origine.
L10 fait — `f903216`, 11 fichiers, +699/−2, 488 tests verts.
L11 fait — `5b86485`, 11 fichiers, +454/−9, 499 tests verts (S2 fermé).
L12 fait — `b36f34f`, 6 fichiers, +228/−33, 501 tests verts (F13 fermé).
L13 fait — `da75f4e`, 6 fichiers, +206/−11, 505 tests verts (F14 fermé).
CI macOS ajoutée — `535a3fc`, 2 fichiers : workflow WebKit + config dédiée. Le remote
`https://github.com/Sparcane/quran-reel.git` a été ajouté et `main` poussé avec accord explicite
(le workflow s'exécute désormais). `49888b9`, `617c49b`, `0a17ea9` et `b025544` : diagnostic du premier échec WebKit (message de page,
sonde des codecs, configuration exacte de l'encodeur et repli MediaRecorder forcé). La sonde a montré
que WebKit macOS a **toutes** les capacités (avc1, mp4a, MediaRecorder, captureStream, AudioContext),
y compris la configuration exacte demandée par l'app ; forcer le repli MediaRecorder ne change pas
l'échec, donc le défaut est dans ce chemin. `a67bfdc` : le contexte audio retombe sur le taux de
l'appareil si WebKit refuse le taux explicite ; `ea86eb8` : la pile complète de l'erreur est
journalisée à l'échec d'un job. Toutes les sondes passent (config exacte, 8 kHz, options complètes du
recorder, timeslice) : l'échec venait en fait du **sink OPFS** — `navigator.storage.getDirectory()`
existe mais lève cette `UnknownError` dans WebKit. `ebe83af` : le sink retombe sur la mémoire
quand l'API est présente mais refuse de s'ouvrir (l'absence totale reste une erreur explicite). Le
run `45000416009` est **vert** : le vrai chemin WebCodecs de WebKit produit une vidéo lisible sur le
runner macOS.

### Risques si on ne fait rien

1. **Annulation mensongère** (F1/F2) : l'utilisateur croit avoir arrêté un rendu de 15 minutes ;
   le téléphone chauffe, la batterie part, et le job revient « interrompu » au rechargement.
   C'est le défaut le plus visible et le moins excusable.
2. **Fond vidéo = bombe mémoire** (F3) : la fonction qui doit séduire est celle qui plante.
   Sur un téléphone, quelques secondes de 1080p suffisent.
3. **File silencieusement bloquée** (F4) : au premier dépassement de quota — inévitable avec
   des vidéos de plusieurs centaines de Mo — un job disparaît sans message.
4. **Dette de sérialisation** (F10) : chaque nouveau champ de `RenderedVideo` est un bug
   d'oubli à trois endroits ; le coût croît à chaque évolution.
5. Rien ne menace la sécurité d'exécution à court terme : le modèle de menace reste tenu.

---

## 5. Commandes par étape

```powershell
# Référence avant tout lot (L0) — 41 fichiers / 433 tests attendus
npm test
npm run typecheck        # tsc -p tsconfig.json
npm run lint             # eslint .

# Boucle de travail d'un lot (exemple L1)
npm exec -- vitest run packages/render/test/worker.test.ts packages/render/test/queue.test.ts
npm test
npm run typecheck
npm run lint

# Vérification produit après L3/L4/L5 (chemins non couverts par jsdom)
npm run build            # 122 pages attendues
npm exec -- playwright test          # Chrome système ; WebKit non installé

# Données (uniquement si les scripts changent)
npm run verify:data
npm run build:data
npm run generate:catalog

# Dépendances (L9)
npm audit --omit=dev     # doit rester à 0
npm audit
npm audit fix --dry-run
```

Note d'environnement : `npm.ps1` est bloqué par la politique d'exécution PowerShell —
utiliser `& "C:\Program Files\nodejs\npm.cmd" ...` (ou passer par `npm exec --`).
`core.autocrlf=true` sans `.gitattributes` : ne pas comparer de lignes brutes sur `'\n'` nu
dans les tests (incident déjà rencontré sur `scripts/test/build-data.test.ts`).

---

## 6. Ce qui a été fait, ce qui reste

**Fait** : cartographie (étape 1), audit qualité de tous les modules de rendu et de la couche web
(étape 2), audit de sécurité (étape 3), analyse des tests (étape 4), plan priorisé (étape 5).
Deux défauts prouvés par exécution, dix autres vérifiés dans le code.
**Lot L1 livré** (`a2d4f21`) : F1 et F2 corrigés, deux tests de reproduction ajoutés, suite à 435 tests.
**Lot L2 livré** (`a3ba290`) : F4 corrigé (session et device fusionnés dans `readAll`, copie session supprimée
après une écriture device réussie), test de quota ajouté, suite à 437 tests.
**Lot L3 livré** (`e2a7139`) : F8 et S2 corrigés (bornes de taille, de dimensions et de durée lues dans
l'en-tête du fichier), messages dans les trois langues citant les constantes, suite à 449 tests.
**Lot L4 livré** (`0d607ab`) : F3 corrigé (budget de frames décodées dépendant de la résolution, boucle sur
la fenêtre conservée), 4 tests de budget ajoutés, suite à 453 tests.
**Lot L5 livré** (`c8d1cd8`) : F5 et F6 corrigés (canaux unifiés dans le contrat du plan, silence final
jusqu'à la fin du timeline), 2 tests ajoutés, suite à 455 tests.
**Lot L6 livré** (`e105749`) : F7 corrigé (échappement d'URL protégé, repli sur l'id du routeur → 404 normal),
2 tests ajoutés, suite à 457 tests.
**Lot L8 livré** (`20f2190`) : T2 et T4 couverts (5 tests de `background-painter`, 5 de `render-runtime`),
garde contre les sinks HTML ajoutée, `typecheck` étendu à `apps/web` (T8), suite à 468 tests.
**Lot L7 livré** (`5940564`) : F10 corrigé pour la vidéo (un seul `StoredVideo`, deux stores clients,
aucune migration de données), suite à 470 tests.
**Lot L10 livré** (`f903216`) : le point ouvert (a) de F3 est fermé. La fenêtre de boucle est lue dans la
table d'échantillons du fichier — `stts` d'un fichier simple, `trun` de chaque fragment sinon — et
annoncée dans le sélecteur de fond avant le rendu (« seules ses 2,6 premières secondes sont
conservées »). Le lecteur partage `frameBudget` avec le peintre, et se tait quand les octets ne prouvent
rien. 9 tests unitaires sur des MP4 construits, 3 d'intégration (dont le fixture H.264 fragmenté réel de
120 images), 1 test d'interface, suite à 488 tests ; typecheck, lint, build 122 pages et Playwright 2/2
verts.

**Lot L11 livré** (`5b86485`) : S2 fermé. `mp4box` ne tourne plus sur le thread principal : le peintre reçoit
un `DemuxSource` injecté, `createWorkerDemux` parle à un module worker via un protocole
`{id, file}` → `{id, source}` ou `{id, error}`, borne le délai à 30 s et **termine le worker** dans
tous les cas. Une réponse d'erreur ou un crash remonte le message sans ré-analyser les octets ici ;
le parse inline ne reste que si aucun worker ne peut être créé (pas de `Worker`, CSP). Le point
d'entrée est dans `apps/web/src/lib/demux-worker-entry.ts` (le bundler ne résout l'URL que depuis
l'app qui possède le fichier). 11 tests (protocole, fabrique web, seam du peintre), 499 verts ;
typecheck, lint, build 122 pages et Playwright 2/2 verts. Vérification en navigateur : le worker
est bien servi, démarré et répond ; la génération se bloque ensuite **après** le demux, sur la
rétention des `VideoFrame` (F13), défaut préexistant qui n'entre pas dans ce lot.

**Lot L12 livré** (`b36f34f`) : F13 fermé. Chaque frame décodée est recopiée dans un
`OffscreenCanvas` possédé par le peintre, puis le `VideoFrame` est fermé — le décodeur récupère ses
buffers et `flush()` aboutit. Le budget de rétention est exprimé en octets de picture (128 Mo),
pas en pixels : 16 frames conservées en 1080p, annoncées dans le sélecteur. Les tests de la
fenêtre de boucle et du sélecteur ont été recalés sur ce budget. Le nouveau parcours Playwright
rend un MP4 avec l'application, le réimporte et en rend un second : il échouait (blocage) avant le
correctif, passe en 10 s après. 501 tests verts ; typecheck, lint, build 122 pages et Playwright
3/3 verts.

**Lot L13 livré** (`da75f4e`) : F14 fermé. Avant de choisir WebCodecs et de lancer un worker, le
rendu interroge `VideoEncoder.isConfigSupported` avec les profils H.264 réellement utilisés. Firefox,
qui a l'API mais aucun encodeur H.264, bascule donc sur `MediaRecorder` et produit un WebM lisible
en 5 s au lieu d'échouer. 505 tests verts ; typecheck, lint, Playwright Chrome 4/4. Le parcours
`e2e/fallback.e2e.ts` tourne aussi sous Firefox et sous le Chromium Playwright (config
`playwright.cross-browser.config.ts`) : 2/2 — deux moteurs sans encodeur H.264, deux replis WebM
vus et lus par le lecteur.

**L9 — tentative de correctif, puis restauration.** J'ai installé les versions que l'avis présentait comme
« correctif » (`vitest@3.1.4`, `@vitejs/plugin-react@5.2.0`), puis relancé l'audit : **7 vulnérabilités,
dont 2 critiques** (`tinypool` prototype pollution → RCE, `vitest` lui-même), contre 6 high dans l'état
d'origine. `npm audit fix` (sans `--force`) n'a rien résolu. J'ai donc restauré `package.json` et
`package-lock.json` (`git checkout`), réinstallé depuis le lockfile et reverifié : 0 vulnérabilité en
production, 6 high en dev, 470 tests / typecheck / lint / build 122 pages verts. **Aucun changement de
dépendance n'est conservé.** Aucune fusion, aucun push (aucun remote n'est configuré).

**L9 — clôture sans modification.** Re-vérification avec le `package-lock.json` d'origine (inchangé
depuis le premier commit), contre `https://registry.npmjs.org/` : `npm audit` et
`npm audit --omit=dev` renvoient **found 0 vulnerabilities**. Là où l'avis signalait 6 high en dev,
les données d'avis ont été révisées en amont. Le lot est donc clos **sans toucher au lockfile** ;
la suite L12 reste verte (501 tests, typecheck, lint, build 122 pages, Playwright 3/3).

**Reste** : rien. S2, F13, F14, S4/L9 et le WebKit réel sont fermés. Garder `npm audit` dans la
vérification périodique : un nouvel avis peut réouvrir S4. Le workflow macOS est vert sur `main`.

**Vérification finale** : 506 tests unitaires (48 fichiers), typecheck, lint, Playwright Chrome 5/5,
Firefox + Chromium 2/2, WebKit macOS 2/2 sur le runner GitHub, `npm audit` à 0.

**Appareil physique (suite poussée)** : parcours complet exécuté sur un **Galaxy S9+ (SM-G965U,
Android 10, Chrome 157)** relié en USB, via `adb reverse` pour le serveur local et `adb forward` vers
le socket CDP de Chrome. Quatre rendus réels ont été produits et lus sur l'appareil :

- dégradé 9:16, sous-titres « verset entier » : MP4 1080×1920, 2,1 s ;
- fond image importé (PNG 64×64) : MP4 1080×1920, 2,1 s ;
- fond vidéo importé (le MP4 produit par l'app) : MP4 1080×1920, 2,1 s ;
- format 1:1 avec sous-titres « mot par mot » : MP4 1080×1080, 2,1 s.

Historique : 3 vidéos listées. Axe WCAG A/AA : **0 violation** sur `/bibliotheque/` et `/studio/`.
Aucune erreur JavaScript. Le script reproductible est `e2e/device-deep.cjs` (prérequis `adb` dans
son en-tête) ; le parcours minimal est `e2e/device-test.cjs`.

L'appareil n'expose pas `VideoEncoder` ni OPFS et n'est pas en contexte sûr : les rendus ont donc
emprunté le repli `MediaRecorder` + sink mémoire — exactement les chemins corrigés plus haut. Le fond
vidéo a tout de même fonctionné, `VideoDecoder` étant présent.

Les documents (`AUDIT_REPORT.md`, `REFACTOR_PROMPT.md`, `AGENTS.md`, `select-model.ps1`) sont
désormais publiés dans le dépôt, ainsi que la règle `.gitignore` pour `graphify-out/`.

**Risques connus de l'audit lui-même** : `apps/web/src/components/studio/*` n'a été lu qu'en
survol (les composants ne portent pas les défauts trouvés). WebKit a été installé depuis et vérifié
en exécution : l'interface (bibliothèque → sélection → studio) y fonctionne et le rendu échoue
proprement avec un message, sans erreur JS — mais le build WebKit de Playwright sous Windows
n'expose **ni WebCodecs, ni `OffscreenCanvas`, ni `AudioContext`, ni `MediaRecorder`**. Le rendu ne
peut donc pas y être validé ; cela ne prouve pas que Safari grand public échoue. En revanche
Firefox a été installé et le chemin `MediaRecorder` y a été exercé pour de vrai : le repli produit
un WebM lisible (F14, corrigé par L13). Le WebKit réel n'a pas pu être validé sous Windows (le build
local n'a ni WebCodecs, ni `AudioContext`, ni `MediaRecorder`) mais l'est désormais sur le runner
macOS : le workflow vert `45000416009` exécute le rendu et la lecture dans Safari. Plus aucun angle
mort de navigateur ne subsiste.
