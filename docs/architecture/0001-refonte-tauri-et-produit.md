# 0001 — Refonte : desktop Tauri et architecture du produit

- **Statut :** proposition révisée après deux passes de revue Codex, en attente de validation
- **Date :** 2026-11-06
- **Périmètre :** tout le produit — desktop, console, API, worker, link-gateway, connecteur hôte,
  protocole, et leurs effets sur `openedbot-pro`
- **Source :** quatre audits en lecture seule au commit `7ec962d` (develop), puis une revue Codex
  qui a vérifié les affirmations dans le code (section 10). `O` = observé dans le code,
  `I` = déduit, à confirmer

## 1. Contexte et problème

Le desktop est un shell Electron 44 (`apps/desktop`, 4 400 lignes) qui charge la console web
**distante** (`${consoleUrl}/`, `apps/desktop/src/main/window.ts:208`). La performance perçue est
mauvaise. Constats (O) :

- à chaque lancement, la SPA est téléchargée puis parsée ; rien n'est embarqué, et service
  worker et CacheStorage sont purgés au démarrage (`window.ts:291`) ;
- chunk d'entrée de la console : 1,39 Mo minifié, 411 ko gzip, 384 assets ;
- `ConversationScreen` (composer, timeline, react-markdown, KaTeX) et `SupportPanel` sont importés
  statiquement depuis `route-tree.tsx` ; le barrel de `browser/ui-kit` réexporte tout ;
- pendant un streaming, chaque frame redécoupe la réponse et peut re-rendre la timeline entière
  (1 590 lignes, un seul `memo`, pas de virtualisation) ;
- coût fixe d'Electron : trois processus et un Chromium embarqué.

Les audits ont aussi relevé des dettes de structure côté serveur, sans lien avec le desktop, que
l'utilisateur veut traiter dans le même chantier (sections 4.5 à 4.7).

## 2. Décisions déjà prises (2026-11-06)

| Sujet | Décision |
|---|---|
| Shell desktop | Electron → **Tauri 2** (Rust), WebView du système |
| Console dans le desktop | **Embarquée** dans l'app, servie par le protocole local de Tauri |
| Plateformes | **macOS d'abord**, puis Windows (WebView2), puis Linux (WebKitGTK) |
| Revue | Codex relit ce document, puis `codex review --base develop` sur chaque branche d'étape |
| Périmètre | Tout le produit |

## 3. Objectifs et non-objectifs

### Objectifs mesurables

Cibles fixées après la mesure de référence D0 (section 3.1, après les non-objectifs). La colonne « Electron aujourd'hui »
reprend la médiane mesurée.

| # | Objectif | Electron aujourd'hui (D0) | Cible |
|---|---|---|---|
| G1 | Temps du lancement à la liste des fils utilisable, dans trois cas : premier lancement, lancement suivant, premier lancement après mise à jour (le cache de requêtes est invalidé à chaque build, `query-persister.ts:23`) | suivant 452 ms (573 ms en réseau simulé) ; premier 564 ms (1 399 ms en réseau simulé) ; après mise à jour 482 ms (987 ms en réseau simulé) | **≤ 450 ms** au lancement suivant et **≤ 600 ms** au premier lancement comme après une mise à jour, **quel que soit le réseau** |
| G2 | JS chargé par la console | entrée 398 ko gzip ; 859 ko gzip de JS sur 54 fichiers avant la liste des fils | entrée **≤ 200 ko gzip** ; JS chargé avant la liste des fils **≤ 400 ko gzip** |
| G3 | Mémoire au repos, tous processus de l'app, 30 s après l'ouverture d'un fil | 660 Mo (4 processus) | **≤ 330 Mo** (−50 %) |
| G4 | Streaming d'une réponse longue (~9 000 caractères, environ 2 000 tokens) | 0 frame longue pendant le streaming à la remesure (une première série en comptait 2 et 9, sur une fenêtre plus large) ; fps moyen 120, p5 98 à 100 sur un écran à 120 Hz | **aucune frame longue > 50 ms**, avant comme pendant le streaming ; fps p5 ≥ 90 % de la fréquence de l'écran (82 à 83 % aujourd'hui) |
| G5 | Une seule source de vérité par concept : écritures de création d'un tour, transitions d'un run, contrat du pont natif, contrat du connecteur | vérifiée par un garde en CI |

### Non-objectifs

- **Pas de cœur local.** Le desktop reste un client de l'API cloud : pas de base locale, pas
  d'API embarquée, pas de mode hors ligne au-delà du cache de requêtes existant. Les hypothèses
  « cloud only » relevées par l'audit (RLS Postgres, GUC, rôles) restent valides.
- Pas de réécriture de la console dans un autre framework : React 19 reste, on l'allège.
- Pas de changement du connecteur Go ni de Hermes au-delà des sections 4.7 (clé d'appareil,
  corrélation, contrat unique).
- Pas d'application mobile dans ce chantier.

### 3.1 Mesure de référence (D0, 2026-11-06)

Outil : `apps/console/scripts/perf/d0-baseline.ts` (rejouable, écrit `tmp/perf/d0-<date>.json`).
Résultats bruts, non versionnés : G2 et G3 dans `tmp/perf/d0-2026-11-06T09-11-49-579Z.json` ;
G1 dans `tmp/perf/d0-2026-11-06T09-32-03-846Z.json` et G4 dans
`tmp/perf/d0-2026-11-06T10-06-38-327Z.json`, remesurés après les revues Codex de l'outil (voir
« Corrections de l'outil » plus bas).

**Conditions.**
- Machine : Apple M5 Pro, 48 Go, macOS 26.6.2, écran à 120 Hz.
- Logiciels : Electron 44.7.0 (shell compilé, `electron-vite build`) ; Chromium de Playwright 1.64
  en mode headless.
- Console : build de production solo du commit `fe6574f`, servie par un serveur statique qui
  imite la prod (gzip, ETag, `Cache-Control: no-cache` sur le document, comme
  `openedbot-pro/infra/shuttle/web-gate.js` ; les assets hachés, `immutable` en prod, gardent ici
  la fraîcheur heuristique du navigateur, ce qui ne peut que ralentir la mesure) ; `/api` relayé vers
  l'API de dev locale, runtime de la VM de lab 240.
- Essais : 5 par cas de G1 (médiane ci-dessous), 3 pour G3, 2 pour G4. Aucun échec. Aucun essai
  rejeté pour mauvais build : chaque essai vérifie le chunk d'entrée réellement chargé.
- **Marqueur de G1** : le premier lien de la barre latérale vers le fil d'un bot
  (`a[href*="/bot/"]`) est présent et visible. Temps mesuré du lancement du processus (navigateur
  ou Electron) jusqu'au marqueur.
- **Les trois cas de G1** :
  - *premier lancement* : session présente, mais aucun cache HTTP, aucun IndexedDB ni
    localStorage (côté Electron, on garde seulement le fichier de jetons) ;
  - *lancement suivant* : même profil, relancé ;
  - *après mise à jour* : même profil et même origine, après un **second build** dont le build id
    et le chunk d'entrée diffèrent.
- **Réseau** : « local » n'a aucune latence ; le « réseau simulé » ajoute 50 ms d'aller-retour
  par réponse et 50 Mbit/s pour les fichiers. Le serveur parle HTTP/1.1 (6 connexions), là où la
  prod passe par HTTP/2 : la simulation pénalise un peu trop les nombreux petits chunks.

| Indicateur | Web (Chromium headless) | Electron 44 |
|---|---|---|
| G1 premier lancement, local / réseau simulé | 538 / 1 174 ms | 564 / 1 399 ms |
| G1 lancement suivant, local / réseau simulé | 445 / 589 ms | 452 / 573 ms |
| G1 après mise à jour, local / réseau simulé | 455 / 1 083 ms | 482 / 987 ms |
| G1 côté page seulement (depuis la navigation), local : premier / suivant / mise à jour | 244 / 170 / 172 ms | non mesuré (*) |
| G2 chunk d'entrée | 1 356 ko brut, 398 ko gzip | même build |
| G2 avant la liste des fils | JS : 54 fichiers, 2 855 ko brut, 859 ko gzip, 713 ko brotli ; CSS : 2 fichiers, 69 ko gzip | même build |
| G3 mémoire au repos | 1 135 Mo (***) | **660 Mo**, 4 processus |
| G4 délai avant le premier texte | 9,6 et 12,8 s (modèle et hôte compris) | 9,2 et 9,6 s |
| G4 frames longues (> 50 ms) avant le premier texte (envoi, « réflexion ») | 0 | 0 |
| G4 frames longues (> 50 ms) pendant le streaming | 0 | 0 |
| G4 fps moyen / p5, pendant le streaming | 60 / 59,5 à 59,9 (headless plafonné à 60) | 120 / 98 à 100 |

(*) Electron charge la console avant qu'une sonde puisse s'attacher : seul le temps total est mesuré.
(***) Chromium headless sans vraie composition GPU, à titre indicatif seulement ; non comparable à
Electron.

**Ce que ça dit.**
- Sur cette machine, le lancement d'Electron n'est **pas** lent quand le réseau est rapide :
  452 ms au lancement suivant. Le coût vient du réseau. Avec 50 ms d'aller-retour, un premier
  lancement monte à 1,4 s, dont environ 850 ms de téléchargement des 54 fichiers de la console,
  et le premier lancement après une mise à jour à environ 1 s. C'est exactement ce que la
  console embarquée supprime.
- La console télécharge plus du double de son chunk d'entrée avant d'afficher la liste : 859 ko
  gzip. L'écran d'accueil (`overview`) entraîne avec lui les échelles d3 de recharts, le
  markdown du support et KaTeX (liste complète dans le JSON).
- La mémoire (660 Mo) est le vrai écart mesuré. Le streaming est fluide sur cette machine, mais
  les fps p5 restent à 82–83 % de la fréquence de l'écran, et une première série a compté des frames
  longues : à revérifier sur une machine modeste.
- **Cache du document en prod (vérifié le 2026-11-06) :** la prod sert `index.html` en
  `Cache-Control: no-cache` (`web-gate.js`, `cacheControlFor` ; en-tête relu sur
  `https://openedbot.app/`). Le `web.Caddyfile`, sans `Cache-Control`, ne sert plus que l'ancien
  stack du lab : le défaut de fraîcheur qui faussait la première mesure n'existe pas en prod.

**Non mesuré dans D0.**
- La vraie prod sur Internet (latence, TLS, Cloudflare) : uniquement le local et la VM 240.
- Une machine moins puissante que ce M5 Pro.
- La navigation d'un fil à l'autre, la latence de frappe dans le composer, le défilement d'un
  long fil.
- Le premier lancement avec connexion : il dépend de l'e-mail et n'a pas de sens en temps.
- Chaque réponse de G4 allonge le fil de test d'Atlas (de 12 000 à plus de 100 000 caractères
  affichés au fil des essais, au-delà de la fenêtre de 40 tours de la timeline). Les mesures de G3 et G4 ont donc été faites sur un fil qui grandit.

**Corrections de l'outil (revue Codex de `perf/d0-baseline`).** Les trois défauts relevés touchaient
la validité des chiffres ; G1 et G4 ont été remesurés après correction.
- Le cas « après mise à jour » pouvait mesurer l'ancien build : sans `Cache-Control`, Chromium
  réutilisait le `index.html` du build A. Le serveur de mesure revalide maintenant le document
  (`no-cache`, comme la prod) en gardant le cache des assets, et chaque essai vérifie le chunk d'entrée chargé ;
  un essai sur le mauvais build est rejeté et compté. Effet : en réseau simulé, le cas passe de
  531 à 1 083 ms côté web, et de 562 à 987 ms côté Electron. La dispersion inexpliquée de la
  première série venait de là. La revalidation coûte aussi un aller-retour au lancement suivant
  (+10 à 50 ms en réseau simulé).
- G4 comptait les frames longues depuis l'envoi, mais les fps depuis le premier texte. Les deux
  utilisent maintenant la fenêtre du streaming ; l'activité entre l'envoi et le premier texte est
  rapportée à part.
- G4 suivait le texte de tout le fil, qui peut diminuer au-delà de 40 tours, et datait la
  croissance au moment des sondages de l'API. La sonde suit maintenant la réponse elle-même (le
  nouveau `[data-assistant-response]`) et horodate sa croissance dans la page ; la fenêtre
  s'étend de 250 ms après la dernière croissance pour mesurer le rendu d'une réponse arrivée d'un
  bloc. Les intervalles (frames, frames longues) comptent dès qu'ils chevauchent la fenêtre,
  pour ne pas perdre un blocage qui se termine juste après. Remesure : fps p5 d'Electron de 98 à
  100 (contre 102 à 103), toujours aucune frame longue.
- Les échecs d'initialisation d'Electron arrêtent le processus lancé ; les essais de streaming
  ont leur propre boucle, pour respecter `--stream-runs` ; chaque sondage de l'API est borné par
  l'échéance de l'essai.
- Les contextes de navigateur des boucles mémoire et streaming sont fermés dans un `finally`.

### 3.2 Chargement (D1b, 2026-11-06)

Même machine, même script (`apps/console/scripts/perf/d0-baseline.ts`, 5 essais, médianes),
même compte et même runtime que D0 ; console solo du commit de D1b. G3 et G4 n'étaient pas visés.

| Indicateur | Web avant (D0) | Web après | Electron avant (D0) | Electron après |
|---|---|---|---|---|
| G1 premier lancement, local / réseau simulé | 538 / 1 174 ms | 489 / 863 ms | 564 / 1 399 ms | 537 / 1 141 ms |
| G1 lancement suivant, local / réseau simulé | 445 / 589 ms | 409 / 549 ms | 452 / 573 ms | 426 / 553 ms |
| G1 après mise à jour, local / réseau simulé | 455 / 1 083 ms | 430 / 844 ms | 482 / 987 ms | 438 / 663 ms |
| G2 JS avant la liste des fils | 859 ko gzip, 54 fichiers | **389 ko gzip, 27 fichiers** | même build | même build |
| G3 mémoire au repos | 1 135 Mo (indicatif) | 1 208 Mo (indicatif) | 660 Mo | 707 Mo |

**Ce qui a changé.**
- Chargés à l'ouverture et non plus au lancement : l'écran de conversation (préchargé par le
  loader de sa route, en même temps que le fil), l'écran « bot en création », les trois
  dialogues du bot, les dialogues des menus de la barre latérale, la palette ⌘K (les raccourcis
  restent montés), la carte du guichet de support, le markdown des notes de version du
  connecteur, les graphiques et la table de la Vue d'ensemble. La feuille de style de KaTeX
  était importée par `main.tsx`, ce qui tirait tout le chunk de KaTeX (76 ko) dans le premier
  chargement : elle part avec le rendu markdown du fil.
- `@openedbot/browser-ui-kit` se déclare sans effet de bord (`sideEffects`) : son barrel ne
  tire plus vaul, cmdk et les autres composants dans le premier chargement de qui n'en utilise
  qu'un.
- Les modules du premier chargement venant de `node_modules` et du kit d'interface sont
  regroupés en deux chunks (`boot-vendor`, `boot-ui-kit`, groupes `$initial` de Rolldown). Sans
  ce regroupement, le premier chargement comptait environ 80 fichiers, et le premier lancement
  en réseau simulé passait à 1,5 s (plus lent qu'avant) : HTTP/1.1 ne sert que 6 fichiers à la
  fois. La prod sert en HTTP/2 et la console embarquée n'aura plus de réseau, mais la cascade
  reste à éviter.
- `index.html` précharge le dictionnaire de la langue active (`vite-locale-preload.ts`) :
  `main.tsx` l'attend avant le premier rendu, et il n'était découvert qu'après l'exécution de
  l'entrée.

**Lecture.**
- G2 est atteint. La cible « entrée ≤ 200 ko gzip » ne dit plus grand-chose depuis le
  regroupement : l'entrée fait 74 ko, mais `boot-vendor` (167 ko) est chargé avec elle. Le
  budget suivi en CI (`make bundle-budget`, job « Console bundle budget ») porte donc sur le
  **premier chargement** : tous les scripts de `index.html` et le plus gros dictionnaire,
  369 ko gzip pour un plafond de 380 ko. Le plafond laisse ~20 ko au chunk de la route
  d'arrivée sous les 400 ko de G2. L'entrée garde son plafond de 200 ko.
- G1 « après mise à jour » en réseau simulé passe sous 700 ms dans Electron, sans atteindre les
  600 ms visés ; le premier lancement en réseau simulé reste à 0,9–1,1 s. Ces deux cas
  dépendent du réseau, ce que la console embarquée supprime (D2).
- La mémoire n'a pas baissé (707 Mo contre 660 Mo). L'écart n'est pas expliqué : le fil de test
  d'Atlas grandit à chaque série de G4 (section 3.1) et G3 se mesure fil ouvert. G3 reste
  l'affaire du shell (D2), pas du chargement.
- Non fait, faute de gain mesuré suffisant : une seule librairie d'icônes (Q4) ; `@remixicon/react`
  pèse encore 38 ko (avant gzip) dans le premier chargement.

### 3.3 Streaming (D1c, 2026-11-06)

Même machine, même compte, même bot (Atlas), même runtime (VM 240) et même invite que D0 ; la
réponse fait 8 919 caractères à chaque essai. Consoles : builds de production solo de `develop`
(D1b, « avant ») et de D1c (« après »), servis comme en D0. Résultats bruts, non versionnés :
`tmp/perf/stream-profile-2026-11-06T12-41-34-271Z.json` et `…T12-44-31-029Z.json` (1x),
`…T12-47-36-260Z.json` et `…T12-49-26-185Z.json` (4x).

**Conditions.**
- Outil : `apps/console/scripts/perf/stream-profile.ts --build <build> --headed --cpu none`, qui
  joue l'essai G4 de `d0-baseline.ts` (même sonde, `lib/streaming.ts`) sur un build donné. Le
  Chromium headless de D0 cadence à 60 i/s quel que soit l'écran : la cible « p5 ≥ 90 % de la
  fréquence » n'y était pas mesurable sur le web. Les essais tournent donc dans une vraie fenêtre
  (120 Hz) ; `d0-baseline.ts` reçoit `--headed-stream` pour la même raison.
- La sonde ajoute trois lectures : le fps de la page ouverte au repos pendant 3 s avant l'envoi
  (le plancher de la mesure), la part de frames qui ont sauté un rafraîchissement (plus de 1,5 fois
  la frame médiane) et le détail des frames longues (scripts, mise en page forcée, phase).
- Deux allures : processeur normal (5 essais par build) et ralenti 4 fois par CDP
  (`--throttle 4`, 3 essais par build), à défaut d'une vraie machine modeste. Le M5 Pro ne laisse
  voir à peu près aucun coût à vitesse normale.

**Profil d'abord** (`--cpu stream`, 4x, avant tout changement), puis décompte des rendus React
par composant pendant une réponse (crochet `__REACT_DEVTOOLS_GLOBAL_HOOK__`, script jetable) :
- chaque lot de fragments patché dans le snapshot re-rendait tout l'écran de conversation (54 à 93
  fois par réponse) : en-tête, barre latérale (le roster bouge avec chaque fragment), composer,
  timeline et son modèle, et plusieurs passes O(n) sur les 3 300 événements du fil
  (`latestThreadReadThrough`, `runTimings`, signatures des tours) ;
- le partage structurel de React Query recopiait chaque patch local conteneur par conteneur : l'index
  des clés d'événements et la reconnaissance d'un ajout en queue (`eventsAppendedFrom`) ratait à
  chaque lot, d'où un parcours du fil à chaque patch ;
- le rail des tours relisait la position de chaque tour (`querySelector` + `getBoundingClientRect`)
  à chaque défilement, donc à chaque frame quand le fil épinglé suit la réponse ;
- chaque mot écrit gardait son animation (`animation-fill-mode: both`) : 1 200 animations encore
  actives à la fin d'une réponse, restylées à chaque frame. Une trace Chromium à 4x mettait le style,
  la mise en page, la peinture et la composition loin devant le JavaScript.

**Ce qui a changé.**
- Store du message en cours (`lib/stream/live-run-text.ts`) : tant que la fin du fil est une réponse
  déjà confirmée (plus de `LIVE_NARRATION_MAX` caractères, sans notice, approbation ni balise
  `MEDIA:`), ses fragments ne sont plus patchés dans le snapshot à chaque frame. `useThreadStream`
  les retient et les patche tous, dans l'ordre du flux, au plus tard 1 s après, ou avant tout autre
  événement. Seule la bulle de cette réponse s'abonne au store (`LiveTimelineEntry`), et y lit le
  texte du run au-delà de sa dernière `sequence` dans le snapshot rendu : les fragments de texte
  arrivent sans curseur (diffusés avant leur commit), le curseur ne pouvait pas servir de repère.
  Le store est nourri avant le patch et coupe là où le modèle de la timeline couperait la bulle :
  même rendue avec les props d'un snapshot plus ancien, la bulle n'affiche ni doublon ni recul.
- Les patchs locaux du fil gardent leur identité dans le cache (`asLocalPatch`).
- Découpage en blocs incrémental (`splitMarkdownBlocksFrom`) : seules les coupures dont la première
  ligne du bloc est complète sont réutilisées ; un test compare la découpe incrémentale à la
  découpe complète à chaque caractère de plusieurs réponses.
- Le rail des tours mesure au plus toutes les 100 ms, la dernière demande n'étant jamais perdue.
- Les animations d'apparition des mots et des blocs passent en `backwards` : leur dernière image
  est le style propre de l'élément, aucun pixel ne change, mais elles ne restent plus actives
  (une vingtaine au lieu de 1 200 en fin de réponse).

| Indicateur (web, fenêtre réelle, 120 Hz) | Avant (D1b) | Après (D1c) |
|---|---|---|
| Rendus par réponse : écran de conversation / barre latérale / timeline | 54–93 / 53 / 53 | 17 / 16 / 16 |
| 1x : fps moyen / p5 (plancher au repos) | 119,9 / 99–100 (99–102) | 120 / 98–99 (97–99) |
| 1x : frame la plus longue ; frames sautées | 15–18 ms ; 0,1–0,2 % | 10 ms (18 une fois) ; 0–0,1 % |
| 1x : frames longues (> 50 ms) avant / pendant le streaming | 0 / 0 | 0 / 0 |
| 4x : fps moyen / p5 | 50–57 / 25–30 | 83–87 / 55 |
| 4x : frames longues avant / pendant le streaming | 1–3 / 1 (74–91 ms) | 1–3 / 1 (74–93 ms) |

**Lecture.**
- G4 est atteint sur le web au sens des frames longues : aucune, avant comme pendant le streaming,
  sur 5 essais. La cible de fps ne se lit pas à 120 Hz sur cette machine : le p5 mesure surtout la
  gigue des horodatages de `requestAnimationFrame` (7 à 9 ms entre deux frames), et le plancher au
  repos a varié de 97 à 110 i/s d'une série à l'autre dans la journée. Le p5 du streaming reste à
  ce plancher, avant comme après ; la part de frames sautées, elle, est quasi nulle des deux côtés.
  À vitesse normale, D1c ne change donc rien de visible sur un M5 Pro, sinon la frame la plus
  longue (10 ms au lieu de 15 à 18).
- Le gain se voit au ralenti : à 4x, fps moyen ×1,6 et p5 ×2. Ce n'est pas encore fluide : le
  reparse du dernier bloc par `react-markdown` à chaque frame du lissage, puis le style, la mise
  en page et la peinture de la bulle qui grandit, font l'essentiel du coût restant. Pistes, non
  faites : cadencer le lissage à 60 Hz, un arbre markdown incrémental.
- Les frames longues qui restent à 4x ne sont pas du streaming : l'envoi (le `keydown` puis le
  rendu qui suit la réponse 202) et la fin du run (le rendu du message persisté). Elles valent 15 à
  25 ms à vitesse normale. Elles relèvent de l'envoi et de D1d, pas de ce store.
- Le texte retenu n'est pas encore dans le snapshot : pendant une réponse, la recherche dans le
  fil, le rail des tours, l'aperçu de la barre latérale et le filigrane de lecture suivent avec au
  plus 1 s de retard.
- Non mesuré : Electron (le shell ne change rien à ce code ; la remesure attend D2), une vraie
  machine modeste, les fils au-delà de la fenêtre de 40 tours (D1d), WKWebView.

### 3.4 Longs fils (D1d, 2026-11-06)

Même machine, même compte, même bot (Atlas, sur le runtime de la VM 240). Consoles : builds de
production solo de `develop` (D1c, « avant ») et de D1d (« après »), servis comme en D0. Résultats
bruts, non versionnés : `tmp/perf/long-thread-2026-11-06T13-25-55-399Z.json` (avant),
`…T14-49-24-788Z.json` (après), `tmp/perf/stream-profile-2026-11-06T14-45-58-244Z.json` (G4 après).

**Conditions.**
- Outil : `apps/console/scripts/perf/long-thread.ts --headed --turns 300`. Le vrai fil d'Atlas
  (environ 450 tours) reçoit 300 tours synthétiques plus anciens, servis par pages de 40 comme
  l'API (`lib/long-thread-fixture.ts`) : prose, code, tableaux, titres, et une image sur cinq tours
  servie avec 150 à 400 ms de retard, pour qu'elle change de hauteur après le rendu. Environ
  750 tours une fois tout chargé.
- Phases d'un essai : ouverture du fil ; défilement régulier (40 px par frame) dans ce qui est
  monté, vers le haut puis vers le bas ; « Charger les messages précédents » jusqu'au bout ; même
  défilement dans tout le fil (trois passes de 120 s au plus) ; mémoire (nœuds DOM du fil, tas JS
  après un GC, métriques Chromium). Frames par `requestAnimationFrame`, frames longues par l'API
  Long Animation Frames. Un « saut » est un `scrollTop` qui bouge entre deux frames de plus que le
  pas, ou à rebours : la page bouge sous le lecteur.
- Fenêtre réelle à 120 Hz, processeur normal ; pas d'essai au ralenti pour ce fil.

**Avant.** La console montait les 40 derniers tours (8 au premier rendu, le reste quand le
navigateur était libre), puis 30 de plus à chaque clic et chaque page reçue, sans jamais en
démonter. Les tours hors de l'écran avaient `content-visibility: auto` avec une taille réservée de
120 px. Mesuré :
- le fil grandit sous le lecteur : la hauteur estimée de 120 px est bien en dessous de la vraie
  (une fois tout mesuré, un tour fait 840 px en moyenne), et chaque tour rendu en arrivant à l'écran repousse la
  page. Remonter les 40 tours montés fait 64 sauts, jusqu'à 4 585 px d'un coup ; la hauteur du fil
  passe de 47 000 à 194 000 px pendant qu'on le lit ;
- une fois tout chargé : 47 700 nœuds dans le fil, 40 000 à 64 000 objets de mise en page, 115 Mo
  de tas ; le défilement tombe à 92 i/s de moyenne, 30 au p5, 11 % de frames sautées ;
- presque chaque chargement d'une page coûte une frame longue (50 à 147 ms).

**Ce qui a changé.**
- La timeline est virtualisée par tour (`lib/thread/thread-virtual.ts`, arithmétique pure, et
  `use-thread-virtual-rows.ts`). Une ligne est un tour ; deux espaceurs tiennent la place des tours
  démontés. Est monté ce qui croise l'écran, plus un écran de marge de chaque côté (600 px au
  moins). Épinglé en bas, la plage part de la fin.
- Hauteurs : mesurées (`offsetHeight`, `ResizeObserver`) et gardées quand un tour est démonté ; un
  tour jamais vu est estimé d'après son contenu (lignes, blocs de code, titres, tableaux, images,
  approbations). `content-visibility` est retiré : c'était lui qui faisait sauter la page.
- Ancrage manuel du lecteur quand il n'est pas en bas : avant chaque changement, l'élément le plus
  profond en haut de l'écran est retenu (pas une puce de date, qui peut disparaître) ; après, le
  défilement compense son déplacement. WKWebView n'a pas `overflow-anchor`, et la colonne le coupe
  déjà : l'ancrage ne dépend pas du navigateur. Un tour qui fusionne avec le précédent après un
  chargement (un run d'accueil) est retrouvé par la clé de son entrée.
- Sélection et focus : les tours qui portent les deux bouts d'une sélection, et le tour du focus
  clavier (`:focus-visible` seulement, un clic de souris ne retient rien), restent montés, avec
  tout ce qui est entre eux. La copie sur plusieurs messages marche donc comme avant.
- Aller à un message : un seul événement (`lib/thread/thread-reveal.ts`, sans dépendance, pour ne
  pas grossir le premier chargement) monte le tour de la cible puis la fait défiler. Il sert à
  `focus=`, à la recherche globale (⌘K), à la recherche dans le fil (⌘F) et au rail des tours, qui
  allume les repères des tours démontés d'après leur rang.
- L'animation d'arrivée ne joue que pour un tour nouveau en fin de fil, jamais pour un tour remonté
  par le défilement.
- « Charger les messages précédents » demande directement la page suivante à l'API (40 tours) :
  il n'y a plus de tours retenus en mémoire sans être montés.

**Pourquoi pas `@tanstack/react-virtual`.** Le fil a déjà un découpage en tours, une colonne
`justify-end` épinglée en bas, des pages ajoutées au-dessus, des approbations et une réponse en
direct (D1c) qui grandissent en bas, et des cibles à atteindre par identifiant. La bibliothèque
gère des index et des tailles, pas l'ancrage sur l'élément lu, l'épinglage, la retenue de la
sélection ni la révélation par cible : il aurait fallu écrire ces parties autour d'elle. Le code
maison fait environ 600 lignes, testées sans navigateur, et n'ajoute rien au bundle.

| Indicateur (web, fenêtre réelle, 120 Hz, 1x) | Avant (D1c) | Après (D1d) |
|---|---|---|
| Ouverture : premier rendu / tours montés complets | 399 / 545 ms | 344 / 355 ms |
| Ouverture : frames longues ; nœuds du fil ; tas JS | 2 (99 et 135 ms) ; 5 405 ; 25 Mo | 0 ; 140 ; 17 Mo |
| Défilement dans ce qui est monté : sauts (le plus grand) | 64 (4 585 px) | 0 |
| Défilement dans ce qui est monté : fps moyen / p5 | 120 / 101 | 120 / 100–101 |
| Chargement d'une page : durée ; frames longues | 450–852 ms ; 13 sur 17 clics (50–147 ms) | 455–774 ms ; 0 sur 10 clics |
| Tout chargé (~750 tours) : nœuds du fil ; objets de mise en page | 47 689 ; 40 319 (64 351 après défilement) | 211 ; 1 472 |
| Tout chargé : tas JS après GC ; mémoire des processus Chromium | 112–115 Mo ; 1 417–1 650 Mo | 32–34 Mo ; 1 064–1 211 Mo |
| Tout le fil, 3 passes de 120 s : fps moyen / p5 ; frames sautées | 92 / 30 ; 10,5–10,9 % | 120 / 99–110 ; 0 % |
| Tout le fil : sauts ; frames longues | 0 ; 2 (50 et 57 ms, script) | 1 (256 px) ; 1 (269 ms, ni script ni mise en page) |
| G4, streaming d'une réponse de ~9 000 caractères, 3 essais : fps p5 ; frames longues | 98–99 ; 0 (D1c) | 98–101 ; 0 |

**Lecture.**
- Le fil long est fluide : avec 750 tours chargés, le défilement reste au niveau du fil court
  (120 i/s, p5 à la gigue de `requestAnimationFrame`, aucune frame sautée), là où l'avant
  tombait à 30 au p5. Le DOM ne dépend plus de la longueur du fil : 140 à 211 nœuds dans le fil
  au lieu de 47 700, 34 Mo de tas au lieu de 115. Le streaming (G4) ne régresse pas.
- La page ne saute plus sous le lecteur. Le seul saut restant (256 px, une fois sur trois passes)
  coïncide avec une image de la fixture qui arrive pendant que son tour entre dans la marge ;
  la sonde compte comme saut une compensation égale au pas, d'où des faux positifs possibles. À
  la main, dans le navigateur, aucun saut vu (chargements successifs, images, fil épinglé).
- La hauteur totale grossit encore pendant le premier passage (586 000 → 650 000 px) : les
  estimations d'un tour jamais vu sont environ 10 à 23 % sous la hauteur réelle des tours
  d'Atlas. L'ancrage compense, la lecture ne bouge pas ; seul le pouce de la barre de défilement
  change de taille. Les estimations se règlent dans `thread-virtual.ts`.
- Une frame de 163 à 269 ms par essai pendant le défilement complet, sans script ni mise en page
  (Long Animation Frames n'attribue rien) : cause non établie, probablement hors de la page (GC du
  navigateur ou compositeur). L'avant n'en avait pas de ce type, mais avait deux frames longues de
  script ; à surveiller sur WKWebView.
- Le premier rendu gagne peu (399 → 344 ms) : il ne montait déjà que 8 tours avant de compléter la fenêtre.
- Vérifié à la main, dans un vrai navigateur (Chromium, Playwright, build de production, fil de
  750 tours) : `focus=` vers un message démonté (centré, anneau, repère du rail allumé) ; ⌘K vers
  un message ; ⌘F vers le 150e tour et le résultat suivant ; clic sur le rail ; cinq chargements
  successifs sans que le message lu bouge ; sélection à la souris sur deux tours gardée après un
  aller-retour en bas, copie complète (559 caractères) ; arbre d'accessibilité (`log`, bouton,
  tours dans l'ordre, espaceurs `aria-hidden`) ; 80 Tab traversent 12 tours sans quitter le fil ;
  coque mobile 390×844 ; pièce jointe image ; vraie carte d'approbation reçue en défilant
  3 000 px plus haut (le fil revient en bas, refus fonctionnel) ; une vraie réponse d'Atlas suivie
  en bas, au plus 4 tours montés, 0 frame longue sur 40 s. Pas de styles d'impression dans la
  console : rien à faire régresser.
- Limites connues :
  - une sélection qui va d'un bout à l'autre du fil garde monté tout ce qui est entre ses bouts ;
  - la recherche native du navigateur (⌘F hors de la console, ou dans le desktop sans la barre de
    recherche du fil) ne voit que les tours montés ; la recherche du fil couvre tout ;
  - un bloc d'activité déplié se replie si son tour est démonté puis remonté ;
  - la recherche globale vers un message d'une page pas encore chargée reste limitée comme avant ;
  - non vérifié : VoiceOver, l'inertie du défilement sur iOS, WKWebView et WebKitGTK (D2, D5),
    une vraie machine modeste.


### 4.1 Vue d'ensemble

Le flux reste le même ; ce qui change est marqué `*…*`.

```
 +---------------------------------------------+
 |  *desktop Tauri*  (Rust)                    |
 |                                             |      +------------------------+
 |   +-------------------+   IPC typé          |      |  API  (Hono / Bun)     |
 |   | console embarquée | <---------------->  | ---> |  HTTPS + SSE, bearer   |
 |   | origine locale    |  *pont natif*       |      |  *origines natives*    |
 |   +-------------------+                     |      |  *garde de version*    |
 |                                             |      +-----------+------------+
 |   auth PKCE, coffre, deep link, notch,      |                  |
 |   *mise à jour signée*                      |                  | Postgres
 +---------------------------------------------+                  v
                                                      +------------------------+
                                                      |  worker                |
                                                      |  *seul à exécuter      |
                                                      |   les effets de run*   |
                                                      +-----------+------------+
                                                                  |
                                                                  v
 +----------------------+   WSS sortant   +------------------------+
 |  hôte utilisateur    | --------------> |  link-gateway          |
 |  connecteur Go       |                 |  *corrélation de bout  |
 |  -> Hermes           |                 |   en bout*             |
 +----------------------+                 +------------------------+
```

Conclusion : le desktop ne touche que le client et une petite partie de l'API (origines,
garde de version) ; le reste du serveur avance sur une piste séparée (section 6).

### 4.2 Variantes et distribution (solo / pro)

Les écrans pro sont injectés **au build** de la console (`apps/console/vite-pro-console.ts:5`,
`OPENEDBOT_CONSOLE_PLUGINS`). La console web de production est construite et déployée depuis
`openedbot-pro`. Une console embarquée construite en solo ne recevrait donc pas les écrans pro,
même connectée à une API pro (O, relevé par Codex).

**Décision (2026-11-06, Q8) : le desktop est solo.**

- la console embarquée est construite **sans** plugins console pro ; le pipeline desktop ne
  récupère pas `openedbot-pro` ;
- quand une route ou une action pro est demandée dans le desktop (lien profond, notification,
  lien partagé), la console affiche « Ouvrir dans le navigateur » et ouvre l'URL publique de la
  console web via l'adaptateur de plateforme, au lieu d'un écran vide ou d'une erreur 404. La
  liste des préfixes de routes pro est un contrat vérifié par un test (I : préfixes à inventorier
  dans `pro-console/registry.ts`) ;
- les écrans pro ne vivent que sur le web, servi depuis l'origine de la console : ils ne sont pas
  concernés par le découplage d'origine de la section 4.4 ;
- les budgets de taille (G2) sont mesurés sur la variante solo pour le desktop, et sur la variante
  web de production pour le web.

### 4.3 Desktop Tauri

**Structure.** Nouvelle app `apps/desktop-tauri` (nom définitif à la bascule) :

```
 apps/desktop-tauri/
   src-tauri/                 Rust : commandes, plugins, notch, coffre, diagnostics
   src-tauri/capabilities/    permissions IPC
   src-tauri/permissions/     permissions des commandes maison
   package.json               workspace Bun : build de la console en mode desktop + bindings
 contracts/native-bridge/     types TS générés depuis Rust (tauri-specta), versionnés
```

Electron (`apps/desktop`) reste livré tel quel jusqu'à la bascule (D3).

**Backend configurable.** Aujourd'hui le shell choisit son backend au lancement (variables
d'environnement, `config.json`, `defaults.json`, `config.ts:37-55`) et isole les jetons par origine
d'API (`target.ts:97-101`). On garde cette capacité : l'origine de l'API est une **configuration
runtime validée** (http seulement pour loopback et réseau local, comme aujourd'hui), avec coffre,
cache de requêtes et stockage isolés par backend. Pas d'`API_ORIGIN` figé au build pour le desktop.

**Correspondance des responsabilités** (O, `apps/desktop/src/main/*`) :

| Electron | Tauri 2 (cible) | Note |
|---|---|---|
| Auth PKCE (`auth.ts`) : code e-mail, Google via navigateur + attente du claim, refresh anticipé mono-vol | Commandes Rust (`reqwest`, proxy système) | Refresh mono-vol **partagé** entre console et notch (`auth.ts:265-273`) |
| Déconnexion : attendre la rotation en cours, révoquer, effacer localement même si la révocation échoue (`auth.ts:467-489`, `main.ts:239-247`) | Même séquence en Rust | Une révocation ratée est journalisée, la session locale est quand même effacée |
| Déconnexion : décharger la console, purger IndexedDB par origine, attendre avant de réafficher la connexion (`window.ts:437-471`) | Équivalent : recharger sur une page vide, purger les données de la WebView pour l'origine locale | Ne pas laisser de données d'un compte au compte suivant |
| Coffre `safeStorage` (`token-store.ts`, `vault.ts`) | Crate `keyring` : Keychain / Credential Manager / Secret Service | Linux sans coffre : session en mémoire seulement, jamais de jeton en clair |
| Choix du backend et isolation par origine (`config.ts`, `target.ts`) | Configuration runtime validée (voir ci-dessus) | |
| `openedbot://auth/callback` + boucle locale `127.0.0.1:47813` (`deep-link.ts`) | `tauri-plugin-deep-link` + même repli | URI déjà autorisées par l'API (`api-config.ts:435`) |
| Instance unique (`main.ts:340`) | `tauri-plugin-single-instance` | Le deep link Windows arrive par la 2e instance |
| Dock (macOS) / tray (Win, Linux) (`tray.ts`) | API tray et menu de Tauri | Modes fenêtre / popup / les deux |
| Raccourci global `Cmd/Ctrl+Shift+O` | `tauri-plugin-global-shortcut` | |
| Fenêtre : position mémorisée et ramenée sur un écran branché (`window.ts:121-142`), fermer = cacher, toujours devant, barre de titre masquée, feux tricolores selon le zoom | `tauri-plugin-window-state` + config de fenêtre + contrôle d'écran au démarrage | Position des feux tricolores : à vérifier sur Tauri 2 (I) |
| Navigation : origines autorisées, `window.open` vers le navigateur | Navigation verrouillée sur l'origine locale, `tauri-plugin-opener` avec liste blanche | |
| Permissions : notifications, presse-papiers | `tauri-plugin-notification`, `tauri-plugin-clipboard-manager` | |
| Menu contextuel (`context-menu.ts:74-116`) : orthographe et dictionnaire, annuler/rétablir, couper/copier/coller, **pas de copie sur un champ mot de passe**, copier le lien, copier l'image | Menu natif de la WebView si la parité est vérifiée, sinon menu maison | La protection du mot de passe est un critère de parité |
| Menus macOS (App, Edit, View, « Taille réelle » = zoom du texte) | Menu Tauri | |
| Hôte du popup notch (`popup-host.ts`, protocole stdin/stdout v1) : un lancement puis jusqu'à 5 redémarrages avec délai ; arrêt immédiat si absent ou incompatible (`:141-149`, `:301-309`) ; routes du popup converties vers l'origine de la console (`:224-271`) | Module Rust, même protocole (`serde`), mêmes règles | La conversion des routes vise désormais l'origine locale |
| Diagnostics SQLite masqués (`diagnostics.ts`) : erreurs de la page, réponses HTTP ≥ 400 et erreurs réseau sur les origines suivies, chargements ratés, renderer disparu ou bloqué (`window.ts:160-193`) | `rusqlite` + même rétention ; erreurs de page et réseau relayées par le pont ; plantage de la WebView détecté côté Rust | Ce que WKWebView expose d'un plantage est à vérifier (I) |
| Thème et zoom du texte (canaux cachés du preload) | Commandes du pont typé | Le facteur de zoom vit à **un** endroit (aujourd'hui 4) |
| Repli `signin.html`, sonde du pont, purge du service worker | **Supprimés** | Inutiles avec une console embarquée |
| — | `tauri-plugin-updater` | Nouveau, voir « Mises à jour » |

**Pont natif.** Un seul contrat, défini par les commandes Rust et généré en TypeScript
(`tauri-specta`) dans `contracts/native-bridge`. La console n'y accède que par **un** adaptateur,
`apps/console/src/lib/platform/` (implémentations `web` et `tauri`). Les 18 imports directs de
`native-bridge` disparaissent ; un garde dependency-cruiser interdit d'importer l'implémentation
ailleurs. Le pont annonce sa version ; une méthode absente donne une erreur nommée, pas un plantage.

**Sécurité IPC.** Les capabilities seules ne restreignent pas les commandes maison (relevé par
Codex). Chaque commande est déclarée dans `AppManifest::commands`, reçoit une permission explicite,
et la capability ne l'accorde qu'à la fenêtre principale sur l'origine locale. Des tests vérifient
le refus depuis une autre fenêtre ou une autre origine. Le jeton d'accès reste côté Rust et n'est
remis qu'à la demande (comme `readAccessToken` aujourd'hui).

**Authentification.** Le desktop reste en **bearer** avec `credentials: "omit"`
(`apps/console/src/lib/api/http.ts:350`), y compris pour le SSE et les plugins pro. Les cookies
restent `SameSite=Lax` (`auth.ts:705`) : on ne les assouplit pas pour une origine locale. Les deux
endroits qui forcent `credentials: "include"` (`browser/api-client/src/api-client.ts:193`,
`support-stream.ts:70`) passent par l'adaptateur.

**Signature macOS.** Hardened runtime **sans App Sandbox**, comme aujourd'hui. On ne recopie pas
les exceptions de V8 (`allow-jit`, `allow-unsigned-executable-memory`,
`build/entitlements.mac.plist:13-16`), puisque WebKit tourne hors processus ; à confirmer par le
prototype. Le popup est copié dans `Contents/Helpers` (`bundle.macOS.files`) **avant** la signature
de l'app, l'ensemble est signé de l'intérieur vers l'extérieur, notarisé, agrafé, puis testé
téléchargé sous quarantaine.

**Mises à jour (conséquence de la console embarquée).** Une correction de la console ne parvient
plus aux utilisateurs desktop par un déploiement web.

- `tauri-plugin-updater`, artefact macOS `.app.tar.gz` signé (distinct du dmg), clé de mise à
  jour distincte du Developer ID et gardée hors de l'hébergement ;
- manifeste par canal (bêta, stable), architecture et variante ; artefacts immuables ; promotion
  d'un canal à l'autre seulement après vérification ;
- l'en-tête `X-OpenedBot-Client: desktop/<version>` sur chaque requête, ajouté aux en-têtes
  autorisés du préflight (`apps/api/src/index.ts:305`) ;
- l'API sert les clients jusqu'à N versions en arrière et répond `426` avec un code stable sous
  une version minimale configurable ; le desktop affiche « mise à jour requise » avec un bouton
  de mise à jour et un lien de réinstallation manuelle.

**Session et données locales à la bascule.** Le moteur et l'origine changent : IndexedDB et
localStorage d'Electron ne sont pas repris. Les brouillons texte sont persistants
(`workspace-draft.ts:10-29`) et seraient perdus. Recommandation (Q1) : une reconnexion unique,
perte des brouillons annoncée dans la note de version, et jamais Electron et Tauri connectés en
même temps avec le même refresh token.

### 4.3.1 Prototype D2a (2026-11-06)

Prototype vertical, non distribué : `apps/desktop-tauri/` (workspace Bun `desktop-tauri`, Rust
dans `src-tauri/`, Tauri 2.12.5), contrat `contracts/native-bridge/`, adaptateur
`apps/console/src/lib/platform/tauri-bridge.ts`. Identifiant `app.openedbot.desktop.preview`, nom
« openedbot preview », service Keychain distinct, aucun schéma `openedbot://` : il cohabite avec
l'app Electron. Mesures sur le Mac de dev (macOS 26.6.2, arm64), API locale, runtime de la VM 240.

**Ce qui est prouvé.**

| # | Point | Preuve |
|---|---|---|
| 1 | Console embarquée | Build solo en mode desktop (`VITE_OPENEDBOT_SHELL=tauri`) servi par `tauri://localhost` ; repli `index.html` de Tauri pour les chemins profonds. Le build web n'embarque rien de Tauri (vérifié sur le bundle ; `make bundle-budget` 370,6 / 380 ko) |
| 2 | Auth bearer côté Rust | Code e-mail (`/api/auth/login/code`, `/native/code/verify`, `/native/token`, PKCE) mené par Rust ; jeton dans le Keychain (`keyring`), remis à la page par `read_access_token` seulement ; refresh mono-vol (test : 8 appels concurrents, 1 rotation) ; coffre refusé : session en mémoire, rien sur disque (tests). Commandes déclarées dans `AppManifest::commands` (`build.rs`), accordées à la seule fenêtre `main` sur l'origine locale (`capabilities/main.json`) ; tests de refus : autre fenêtre, autre origine (`https://console.openedbot.app`, `http://localhost:1420`), commandes des plugins. Pont typé tauri-specta, contrat vérifié par `cargo test` |
| 3 | Fils et SSE | Fenêtre compacte (`/compact`, comme Electron) : sélecteur des fils des 5 bots, fil d'Atlas, envoi d'un message, réponse du runtime de la VM 240 affichée au fil de l'eau sur **une** connexion `/api/events` |
| 4 | Popup notch | L'hôte Rust lance `OpenedbotPopup --hosted` (openedbot-notch `origin/main`, `OpenedbotHostedProtocol` 1) : `ready` (1.0.0) → `hello` → `signedIn` → jeton servi ; le popup appelle l'API avec ce bearer ; il s'arrête sur EOF quand l'app quitte. Vérifié en dev puis dans l'app signée (`Contents/Helpers`) |
| 5 | En-tête `Origin` | Mesuré par une sonde devant l'API (`scripts/origin-probe.ts`) : **`tauri://localhost`** sur chaque requête de la page (préflight compris), app de dev comme app notarisée. Le CORS de D1a répond `Access-Control-Allow-Origin: tauri://localhost`, sans `Allow-Credentials`, et aucun cookie ne part. Les requêtes de Rust (connexion) n'envoient pas d'`Origin` |
| 6 | Signature, notarisation, quarantaine | Developer ID, hardened runtime, sans App Sandbox, **aucun entitlement** ; popup re-signé de l'intérieur (runtime + horodatage) avant l'app ; app et dmg notarisés et agrafés. dmg marqué `com.apple.quarantine` : `spctl -a -t open` → `accepted, source=Notarized Developer ID` ; app glissée dans `/Applications` par le Finder : `spctl -a -vv` accepté, dialogue de premier lancement « Apple a effectué une recherche de logiciels malveillants et n'en a détecté aucun » |
| 7 | Vraie mise à jour | `tauri-plugin-updater`, `.app.tar.gz` signé par une clé minisign distincte (`~/.config/openedbot-tauri-updater/`, 0700/0600), manifeste servi par `scripts/update-feed.ts` (Bun, boucle locale). v0.0.1 installée depuis le dmg ; v0.0.2 publiée ; au lancement suivant : téléchargement (18 Mo), signature vérifiée, popup arrêté, bundle remplacé, **redémarrage en 0.0.2**, session Keychain relue sans invite (même Developer ID, même identifiant), app toujours notarisée. Manifeste 0.0.3 signé par une autre clé : « The signature was created with a different key than the one provided », 0.0.2 intacte, popup jamais arrêté |

**Entitlements retenus : aucun.** `allow-jit` et `allow-unsigned-executable-memory` sont inutiles :
WebKit compile dans ses propres processus, et l'app signée en hardened runtime affiche et fait
tourner la console.

**Durées de notarisation** (quatre passes, toutes `Accepted`) : build release + notarisation et
agrafage de l'app 61 à 77 s au total ; dmg 28 à 34 s (`notarytool submit --wait`).

**Constats.**
- **Le flux SSE n'avait pas d'en-tête CORS** : `/api/events` rend une `Response` brute, qui ne
  reçoit pas les en-têtes posés par `context.header` avant elle. Sans effet sur le web et Electron
  (même origine), bloquant pour la console embarquée (« Flux interrompu : reconnexion en cours »,
  reconnexion toutes les 5 s). Corrigé dans `apps/api/src/interfaces/http/cors.ts` (en-têtes reposés
  sur la réponse finale) et testé ; la preuve 3 a tourné contre une réplique de l'API de cette
  branche sur la base locale, l'API de `make dev` n'ayant pas encore le correctif.
- **App Translocation** : une app en quarantaine que l'utilisateur n'a pas déplacée lui-même (copie
  par script du Finder) tourne depuis un montage en lecture seule ; la mise à jour y échouait
  (« Read-only file system »), proprement. Le prototype ne tente plus rien dans ce cas et le
  journalise ; un vrai glisser-déposer du Finder (dmg → `/Applications`) n'est pas translocalisé.
- La console complète (`/`) ne pose pas sa session cloud depuis le pont : seule la fenêtre
  compacte le fait (`primeNativeSession`). Le prototype ouvre donc `/compact`, comme Electron.
- tauri-specta importe `@tauri-apps/api` en dur ; un contrat n'importe que zod. L'export Rust
  redirige ces imports vers `contracts/native-bridge/src/runtime.ts`, que l'adaptateur de la console
  remplit avec `@tauri-apps/api` : la règle `contrat-zod-seul` reste entière.
- La CSP de la console desktop porte un marqueur à la place de l'origine de l'API (réglage
  d'exécution) ; la coque le remplace en servant `index.html` (`csp.rs`), IPC de Tauri autorisé,
  script d'audience retiré du build.
- Un build de dev non signé change de signature à chaque compilation : le Keychain redemande
  l'accès. En dev, `OPENEDBOT_PREVIEW_VAULT=memory`.

**Reproduire.** `make desktop-tauri-check` (cargo test, clippy), `make desktop-tauri-mac
TAURI_VERSION=0.0.2 TAURI_POPUP=…/OpenedbotPopup.app`, `make desktop-tauri-feed`, `make
desktop-tauri-publish TAURI_VERSION=0.0.2` ; l'app installée lit
`~/Library/Application Support/app.openedbot.desktop.preview/config.json`
(`apiOrigin`, `publicConsoleUrl`, `updateUrl`, `popup`).

**Écarts restant pour D2b.**
- Connexion Google (navigateur + boucle locale `127.0.0.1:47813`), déconnexion avec purge des
  données de la WebView (sans elle, un cache de requêtes d'un compte reste visible au suivant :
  observé), refresh anticipé par minuterie, instance unique, deep link.
- Console complète depuis le pont, `shell.platform` (figé à `"windows"` par le contrat actuel),
  silhouette de démarrage (le script inline de `index.html` ne voit pas encore le pont).
- Mise à jour : vérification périodique et pas seulement au lancement, message « déplacez l'app
  dans Applications » en cas de translocation, écran « mise à jour requise » (426), attente de la
  sortie du popup avant le remplacement, manifeste par canal et variante, hébergement (Q2).
- Popup : dialogue de repli et préférences fenêtre / popup / les deux ; diagnostics SQLite ; menus,
  raccourci global, tray, position de fenêtre.
- `cargo test` et `cargo clippy` en CI (aujourd'hui `make desktop-tauri-check` en local), crates
  pour Windows et Linux (`keyring` n'active que le Keychain).

### 4.3.2 Parité D2b (2026-11-06)

Branche `feat/d2b-macos-parity`. Le shell Tauri reprend le tableau de la section 4.3 sur macOS.
L'identifiant reste `app.openedbot.desktop.preview`, la version commitée reste 0.0.1. Les builds
de test sont numérotés 0.0.4 à 0.0.15, non publiés. Le code propre à macOS est derrière
`#[cfg(target_os = "macos")]` ou dans `src/macos/` : menus, Dock, purge WKWebView, plantage
de la WebView, `Reopen`.

Le parcours de bout en bout a tourné sur l'app **signée Developer ID, notarisée et agrafée**,
installée dans `/Applications` (`spctl` : `accepted, source=Notarized Developer ID`). Elle
utilisait l'API locale de la branche (:8792), derrière une sonde Google locale (:8793), et le
runtime de la VM 240. Les captures sont gardées hors du dépôt.

| Responsabilité (4.3) | État | Preuve |
|---|---|---|
| Code e-mail | Fait | App signée : code reçu par Mailpit, connexion, console complète `/`. La session du pont est posée par la console complète, plus seulement par `/compact` |
| Google (navigateur + claim) | Fait, même parcours qu'Electron | Navigateur système, puis retour par la boucle locale `127.0.0.1:47813`, sondage du claim (1,5 s, 5 min au plus, un 4xx est fatal), échange PKCE. Sur l'app signée, avec un claim simulé côté API locale : connecté 80 à 120 ms après le retour du navigateur. 8 tests Rust : accepté, refusé, URL d'autorisation inattendue, port occupé, délai, annulation, retour anticipé, contrôle des URL. **Non vérifié** : la vraie page de consentement Google, faute d'identifiants OAuth en local |
| Refresh anticipé, mono-vol | Fait | Minuterie : rotation avant l'expiration ; après un échec, nouvel essai 30 s plus tard, jamais de boucle. Tests en temps suspendu |
| Déconnexion | Fait | Révocation, puis effacement local même si l'API est injoignable (test). La console est déchargée sur `about:blank` et le magasin WKWebView est vidé avec attente de sa confirmation (`removeDataOfTypes`). Sur l'app signée : 0 fichier IndexedDB, 0 LocalStorage, aucun item Keychain. Le thème et la taille du texte de l'appareil sont reportés. Une purge qui échoue garde la console fermée (dialogue « Réessayer / Quitter »), et une purge interrompue est reprise au lancement suivant. Une seule purge à la fois |
| Backend configurable, stockage isolé | Fait | Le coffre est rangé par origine d'API (D2a). Les données de la WebView d'un autre backend sont purgées avant que la console ne se charge (`dataOrigin`, journal « purged »). La navigation du popup attend la fin de la purge |
| Deep link + repli boucle locale | Fait, repli seul actif | `tauri-plugin-deep-link`, et le repli testé quand le schéma n'est pas enregistré. La preview ne déclare **aucun** schéma, pour cohabiter avec Electron : seule la boucle locale sert |
| Instance unique | Fait | App signée : un second lancement quitte aussitôt, et la première fenêtre passe au premier plan |
| Dock | Fait | Menu : Affichage (Fenêtre / Popup / Fenêtre et popup, « popup introuvable » si absente), Toujours au premier plan, Se déconnecter. Lu sur l'app signée ; « Se déconnecter » et « Toujours au premier plan » joués. Le mode Popup seul masque l'icône du Dock tant que la fenêtre est cachée : non éprouvé à l'écran |
| Raccourci global `Cmd+Shift+O` | Fait | App signée : fenêtre cachée, puis réaffichée au premier plan. Un raccourci déjà pris est journalisé, sans effet sur le démarrage |
| Fenêtre | Fait, sauf les feux | Fermer = cacher : vérifié, l'app et le notch continuent. Réouverture par le Dock (`Reopen`). Barre de titre en surimpression, feux à (16, 16). Position mémorisée : sur l'app signée, la fenêtre a été déplacée à (240, 110, 1150 × 740), l'app quittée par son menu, et la fenêtre est revenue au même endroit au lancement suivant. Une fenêtre sur un écran débranché est ramenée sur un écran branché (5 tests). « Toujours au premier plan » se règle dans le menu du Dock : coché, la fenêtre reste au-dessus des autres apps, et le choix est retenu |
| Navigation verrouillée, ouverture externe | Fait | Seule l'origine locale est chargée. Un lien web part dans le navigateur, le reste est refusé. Liste blanche d'ouverture : l'API, la console publique, et `openedbot.app/download`. Tests Rust |
| Notifications | Fait | Polyfill de `tauri-plugin-notification` (trois permissions). Le clic revient par l'événement typé `NotificationClicked` et lance l'`onclick` de la page, donc ouvre la conversation. Test TS. **Non éprouvé à l'écran** : aucune notification de workflow dans le parcours |
| Presse-papiers | Partiel | Menu Edit (Cmd+C / V / X / A dans les champs). `navigator.clipboard` sous `tauri://localhost` n'est pas éprouvé |
| Menu contextuel | Menu natif | Menu de WKWebView. **Non vérifié** : la copie interdite sur un champ mot de passe |
| Menus macOS | Fait | App, Edit, View (Actual Size = taille du texte, Zoom In / Out, plein écran), Window : lus sur l'app signée, Zoom Out appliqué |
| Hôte du popup notch | Fait | App signée : popup lancé depuis `Contents/Helpers`, `ready`, puis jeton servi. Le notch affiche les bots et les notifications de la session. Tests : 5 redémarrages puis repli sur la fenêtre avec dialogue, fermeture par l'utilisateur, popup tenu à l'arrêt pendant l'installation d'une mise à jour, lancement réservé sous le verrou de l'arrêt |
| Diagnostics SQLite masqués | Fait | `diagnostics.sqlite`, alimenté par les erreurs de page, la console, `fetch` vers l'API (≥ 400 ou réseau), les avertissements du shell et le plantage du processus WebKit (journalisé, puis rechargement). Masquage sans regex : bearer, JWT, longues suites, requêtes d'URL, e-mails. Limite de débit, rétention 14 jours, 20 000 lignes. Tests |
| Thème et zoom à un endroit | Fait | La taille du texte de la console est le seul facteur (`set_zoom` du shell, retenu au lancement). Le shell publie le zoom en vigueur à la page à chaque changement, menu View compris, pour la place des feux. Thème : apparence de la fenêtre |
| `shell.platform` | Fait | `"macos"` | `"windows"` | `"linux"` (contrat typé), `native-titlebar` reconnaît `macos` |
| Mises à jour | Fait | Vérification 3 s après le lancement, puis toutes les 4 h (`OPENEDBOT_UPDATE_CHECK_SECONDS` pour les tests). Sur l'app signée, **en cours de session**, deux fois (0.0.10 → 0.0.11, 0.0.14 → 0.0.15) : téléchargement, signature vérifiée, popup arrêté (sortie attendue) puis tenu, bundle remplacé, feuille « Mise à jour installée » (Redémarrer / Plus tard). Après « Redémarrer » : la nouvelle version tourne, toujours notarisée, la session Keychain est relue et le popup relancé. « Plus tard » arrête les vérifications jusqu'au redémarrage : couvert par un test seulement, le bouton n'a pas été joué. Si l'app est translocalisée, un dialogue « Déplacez openedbot preview dans Applications » s'affiche et rien n'est tenté (test du chemin) |
| État de mise à jour | Fait (contrat) | `UpdateState` : idle, available, downloading (octets reçus et total), ready, error (code : flux, téléchargement, signature refusée, popup non arrêté, installation, translocation), required. Côté pont : `update_state`, `restart_to_update` (seulement si `ready`), `report_update_required` (le 426 de l'API, version minimale validée : l'état passe à `required` et le flux est vérifié aussitôt), et l'événement `UpdateStateChanged`. Côté notch : un message `updateState` à chaque changement de statut, ajouté dans la v1 (un notch qui ne le connaît pas ignore la ligne). Les dialogues du shell restent provisoires : l'interface (pastille) est l'étape suivante. Tests Rust et IPC ; non éprouvé sur l'app signée |
| CI | Fait | Job `desktop-tauri` (macOS) dans `core-ci.yml` : `make desktop-tauri-check` (cargo test, clippy `-D warnings`), requis par `ci-ok` |
| Tests de refus IPC | Fait | Autre fenêtre, autre origine, commandes des plugins non accordées (fenêtre, deep link, dialog, raccourci, `register_listener`, fs). Capability exacte, diagnostic forgé refusé, zoom inconnu refusé, bindings à jour |

**Constats.**
- Les dialogues sans fenêtre parente passent par `CFUserNotificationDisplayAlert` (rfd), une
  alerte système dans un autre processus. L'invite de redémarrage de l'app signée est apparue en
  retard, hors de l'app, et n'était pas visible dans les captures. Tous les dialogues du shell
  sont désormais des feuilles de la fenêtre principale, amenée au premier plan.
- Quitter par le menu de l'app ne gardait pas la position de la fenêtre. Le shell retient
  maintenant la dernière position à chaque déplacement et l'écrit à la sortie.
- Une fois, après « Se déconnecter » depuis le Dock, la capture de la fenêtre inactive est restée
  vide. La page de connexion était chargée, et s'est affichée dès que la fenêtre est passée au
  premier plan. Une seconde tentative s'est affichée normalement.
- `window.url()` de wry panique tant que la WebView n'a pas d'URL. Le shell n'interroge jamais
  l'URL : l'origine locale est fixe par plateforme.
- `clear_all_browsing_data` (wry) n'attend pas la fin de l'effacement. Sur macOS, la purge passe
  par `WKWebsiteDataStore` avec son handler de complétion.
- Le CLI Tauri lance `npm list` pour vérifier les versions des paquets `@tauri-apps/*` pendant
  `tauri build`. Ce n'est pas un script du dépôt.

**Écarts restants pour D3.**
- Feux tricolores : la place réservée suit le zoom, mais les boutons ne sont pas déplacés selon
  le zoom comme sous Electron.
- Silhouette de démarrage : le script inline de `index.html` ne voit pas encore le pont.
- ~~Écran « mise à jour requise » (426) : pas de bouton de mise à jour par le pont, seulement le
  lien de téléchargement.~~ Fait par D2c (section 4.3.4).
- Manifeste par canal et variante, hébergement du flux (Q2).
- Menu contextuel : copie sur un champ mot de passe à vérifier, sinon menu maison.
- `navigator.clipboard` et le clic sur une notification à éprouver sur l'app signée.
- Google réel : un parcours avec de vrais identifiants OAuth sur un backend de test.
- Schéma `openedbot://` à déclarer au moment où l'app remplace Electron (même identifiant).
- Changer de backend efface aussi le thème et la taille du texte de l'appareil, qui ne sont
  reportés qu'à la déconnexion.
- Une configuration invalide arrête l'app sans dialogue (journal seulement).
- Le raccourci global peut être déjà pris par l'app Electron : le second inscrit perd.
- Linux et Windows : la purge n'a pas de confirmation (pause de 500 ms). La compilation Linux
  n'a pas été vérifiée ici, elle l'est par D5.
- ~~Interface de mise à jour (pastille) branchée sur `UpdateState`. La console doit aussi
  appeler `report_update_required` sur un 426.~~ Fait par D2c (section 4.3.4).
- Version de la bascule : 1.1.0 (dmg de D3).

**Reproduire.** `make desktop-tauri-check`, `make desktop-tauri-mac TAURI_VERSION=X.Y.Z
TAURI_POPUP=…/OpenedbotPopup.app`, `make desktop-tauri-feed`, `make desktop-tauri-publish
TAURI_VERSION=X.Y.Z`. L'app lit `OPENEDBOT_UPDATE_CHECK_SECONDS` pour une vérification
rapprochée.

### 4.3.3 Linux (D5, 2026-11-06)

Le shell Tauri construit et tourne sous Linux (WebKitGTK 4.1), non distribué. L'instance unique,
le plugin deep-link, le bouton de fermeture et le raccourci global viennent de D2b, communs aux
plateformes ; le code propre à Linux (tray, schéma de l'aperçu, enregistrement du gestionnaire par
l'AppImage, pas d'auto-mise à jour pour le deb) vit dans `src-tauri/src/linux.rs` et des
dépendances ciblées (`[target.'cfg(target_os = "linux")']` : Secret Service, tray) ; `lib.rs` et
`updater.rs` n'en gardent que trois points d'appel `#[cfg]`. Tout se
construit et se teste dans l'image `apps/desktop-tauri/linux/Dockerfile` (Ubuntu 24.04, WebKitGTK
2.52.6, Rust 1.98.0, Bun 1.4.4, tauri-driver 2.1.0), sur le Mac de dev par OrbStack : **x86_64
émulé** (Rosetta), **aarch64 natif**. La VM 240 (x86_64, 2 vCPU, 3,9 Go, runtime Hermes) n'a pas
servi : l'émulation suffisait, et rien n'y a été installé.

**Artefacts** (`apps/desktop-tauri/dist-linux/<version>/<arch>/`, ignoré par git, rien de publié).
L'AppImage porte sa signature de mise à jour (`.AppImage.sig`, clé minisign de D2a, montée en
lecture seule dans le conteneur, jamais copiée).

| Fichier | Taille | sha256 |
|---|---|---|
| `1.1.0/x86_64/openedbot-preview_1.1.0_x86_64.deb` | 18,5 Mo | `cf9f5d9ee5b0d71401e5fda2cfb9134047cf672e7fa2091b00e2d0d5ca8760ab` |
| `1.1.0/x86_64/openedbot-preview_1.1.0_x86_64.AppImage` | 92,8 Mo | `4726b004c1421eb27316e6d978a2dbf452ca641f70c0b17c6f7957867950c961` |
| `1.1.0/x86_64/openedbot-preview_1.1.0_x86_64.AppImage.sig` | 452 o | `3a72cfbcaa39edf09b815ce4335b15084f3299c45ef1892db06753027da9de66` |
| `1.1.0/aarch64/openedbot-preview_1.1.0_aarch64.deb` | 18,6 Mo | `988be0f551cc3cbc6ea14da105d892e45a62d18ad7f71289b224589a5586015c` |
| `1.1.0/aarch64/openedbot-preview_1.1.0_aarch64.AppImage` | 90,9 Mo | `713725d022c65b25ec7c62488e4ddd39816b5249f4681e9e32d5da7d24935f50` |
| `1.1.0/aarch64/openedbot-preview_1.1.0_aarch64.AppImage.sig` | 452 o | `4410276704ee0f71aa2b01752022b047cea024c081598f6c8674cfbff78e180c` |
| `1.1.1-test/x86_64/openedbot-preview_1.1.1-test_x86_64.deb` | 18,5 Mo | `5875730ada770f78c5da9c692e9b05e7b94973ed0af10efbc9183630b5f34747` |
| `1.1.1-test/x86_64/openedbot-preview_1.1.1-test_x86_64.AppImage` | 92,8 Mo | `28325670a94d414e490633c3be4bc1d04bd3c5eee4f110fae4f08bc92b78c7e6` |
| `1.1.1-test/x86_64/openedbot-preview_1.1.1-test_x86_64.AppImage.sig` | 464 o | `73f63ea2748d5ccff114cb8e64564eded00f4527c51371b691d9025ee6d3e00f` |

Les 1.1.0 sont construits sur la branche rebasée sur develop 0445bec (S7) ; la 1.1.1-test, cible de
la mise à jour, l'a été sur f3b9361 (D2b) : même shell, seule la console embarquée diffère (S2e, S7).

Le deb dépend de `libwebkit2gtk-4.1-0`, `libgtk-3-0` et `libayatana-appindicator3-1` (ajoutés par
le bundler), déclare `MimeType=x-scheme-handler/openedbot-preview` dans son `.desktop`, et installe
`/usr/bin/openedbot-desktop-preview`. L'AppImage n'est pas « strippée » (`NO_STRIP` : le `strip` de
linuxdeploy ne lit pas les sections `.relr.dyn` des chaînes récentes), d'où ~90 Mo.

**Ce qui est prouvé** (`make desktop-tauri-linux-e2e`, WebDriver par tauri-driver + WebKitWebDriver,
Xvfb, bus D-Bus de session, GNOME Keyring déverrouillé ; API locale du Mac, runtime de la VM 240 ;
chaque point est une vérification qui fait échouer le parcours, pas une simple mesure ; rapport et
captures X11 + WebView dans `dist-linux/e2e/`).

| # | Point | Preuve |
|---|---|---|
| 1 | Démarrage, console embarquée | L'AppImage puis le deb installé (`dpkg -i`) démarrent et affichent la console servie par `tauri://localhost` ; `shell_info.platform = "linux"` |
| 2 | Connexion par code e-mail | `dev@openedbot.local`, code lu dans Mailpit, saisi dans `/login` ; puis la console complète (`/`, depuis D2b) : barre latérale avec les fils des 5 bots (Atlas, Websearch, Essai image, Audit essai, Veille), fil de Websearch |
| 3 | Streaming | Prompt long de D0 envoyé à Websearch (bot à outils, mode auto, runtime de la VM 240) : run `completed`, la réponse grandit au fil de l'eau (capture à mi-réponse), **sur la connexion `/api/events`** : aucun « Flux interrompu », aucun sondage de `/history` pendant le streaming |
| 4 | Coffre | Jeton dans le Secret Service (`secret-tool` le retrouve, `shell_info.persistence = "keystore"`) ; ni le refresh ni l'access token en clair sous `$HOME` ni `/tmp` ; relance sans connexion ×5 ; le deb relit la même session (même identifiant) |
| 5 | Sans Secret Service | Bus de session sans aucun service activable : `persistence = "memory-only"`, journal « session kept in memory only », aucun jeton sur disque, la relance redemande la connexion. Test Rust (`linux::tests`) : le vrai backend `keyring` sans bus refuse lecture et écriture, rien n'est écrit sous un `HOME` jetable ; aller-retour réel sous GNOME Keyring |
| 6 | Instance unique, deep link | Seconde instance : rend la main en ~0,5 s (code 0), la première reçoit `openedbot-preview://open` ; l'AppImage enregistre son gestionnaire (`~/.local/share/applications/openedbot-desktop-preview-handler.desktop`, `xdg-mime`) et `gio open openedbot-preview://open` arrive à l'instance en cours |
| 7 | Tray | Icône (mascotte) dans un tray XEmbed (`stalonetray`, repli de libayatana-appindicator sans hôte StatusNotifier) ; menu Afficher / Masquer, Se déconnecter, Quitter |
| 8 | Bouton de fermeture | Un vrai `WM_DELETE_WINDOW` cache la fenêtre, l'app reste dans le tray, une seconde ouverture la réaffiche |
| 9 | Mise à jour (AppImage) | 1.1.0 → **1.1.1-test** par `scripts/update-feed.ts` (Bun, boucle locale du Mac) : manifeste `linux-x86_64-appimage`, téléchargement, signature vérifiée, fichier remplacé (sha256 = l'AppImage 1.1.1-test), **redémarrage en 1.1.1-test** ; puis manifeste 1.1.2-test signé d'une autre clé : « The signature was created with a different key than the one provided », fichier intact |
| 10 | Deb et mises à jour | Avec un flux configuré, le deb ne tente rien (« not an AppImage: updates come from the package manager ») : le manifeste ne publie que la clé `-appimage` ; un deb se met à jour par son dépôt (à définir) ou par réinstallation |

Sur les artefacts finaux (branche rebasée sur S7), les dix points passent en aarch64 et en x86_64.
Le streaming tourne dans le fil de Websearch : les bots de test d'origine (Designer, Recherche…)
n'existent plus dans l'org de dev, et le fil d'Atlas, partagé avec les tests de D2b, dépasse
100 000 caractères. Avant les premiers builds rebasés, le fil d'Atlas était resté bloqué par deux
runs de ces tests pendant une coupure du lien runtime de `make dev` : le run `db0241ca` a échoué
seul sur le délai du workflow (`WORKFLOW_DEADLINE_EXCEEDED`), et le workflow `unknown` du run
`a9d2cf6e` a été soldé par le chemin de revue (réconciliation refusée faute d'identifiant Hermes,
puis abandon : `EXTERNAL_OUTCOME_ABANDONED`). Un essai interrompu par l'arrêt de l'API (run
`5f6655f9` dans Websearch) a été réconcilié par le même chemin et s'est terminé `completed`.

**Origine mesurée** (sonde `origin-probe.ts` devant l'API, toutes les requêtes de la page) :
**`tauri://localhost`**, comme sur macOS ; préflights compris ; le CORS répond
`Access-Control-Allow-Origin: tauri://localhost`, sans `Allow-Credentials` ; aucun cookie. Les seules
requêtes sans `Origin` viennent de Rust (connexion) et de la sonde. `DEFAULT_NATIVE_APP_ORIGINS`
(`platform/config/src/native-clients.ts`) la couvrait déjà : **aucun changement de l'API**.

**Performance WebKitGTK** (même esprit que D0 : marqueur = premier lien de la barre latérale vers le
fil d'un bot (`a[href*="/bot/"]`) attaché et visible, le marqueur de G1 ; temps mur du `POST
/session` WebDriver, qui lance le processus, au marqueur, sondé toutes les 25 ms ; mémoire = RSS de
l'app et de tous ses processus après 20 s au repos ; streaming = intervalles de
`requestAnimationFrame` pendant la croissance de la réponse, dans le fil de Websearch, console
complète).

| Indicateur | x86_64 (émulé) | aarch64 (natif) | Electron 44, macOS (D0) |
|---|---|---|---|
| Lancement suivant jusqu'à la liste des fils (session restaurée), médiane de 5 | 4,98 s (4,95 à 5,05 s) | **1,09 s** (1,06 à 1,13 s) | 452 ms |
| dont côté page (`performance.now()` au marqueur) | 2,8 à 3,1 s | 0,29 à 0,51 s | non mesuré |
| Connexion : envoi du code à la liste des fils (e-mail compris) | 7,3 s | 3,2 s | — |
| Mémoire au repos (RSS, 3 processus), console complète | 1 072 Mo (web 711, app 275, réseau 86) | **746 Mo** (web 489, app 197, réseau 60) | 660 Mo, 4 processus |
| Streaming : délai avant le premier texte, modèle compris | 6,3 s | 8,4 s | 9,2 et 9,6 s |
| Streaming : durée de la croissance, caractères | 20,6 s, 9 318 | 22,7 s, 8 897 | — |
| Streaming : fps moyen / p5 | 24,8 / 14,9 | 25 / 13,7 | 120 / 98 à 100 |
| Streaming : frames > 50 ms, frame max, frames manquées | 119 sur 519, 134 ms, 18,7 % | 123 sur 575, 214 ms, 21,2 % | 0 |
| fps au repos (fil ouvert, rien ne bouge) | 58,4 | 57 | 120 |

**Limites de ces chiffres.** Xvfb sans GPU : WebKitGTK compose en logiciel (« DRI3 error ») et
`requestAnimationFrame` plafonne vers 55–60 Hz au repos ; l'x86_64 passe par Rosetta, qui pénalise
surtout le JIT JavaScript ; l'aarch64 natif tourne dans la VM Linux d'OrbStack sur un M5 Pro, donc
plus vite qu'un portable Linux ordinaire. WebKit n'a ni `longtask` ni `long-animation-frame` : seuls
les intervalles de frames sont comptés. Avant le rebase, la fenêtre compacte sur le fil d'Atlas donnait des chiffres voisins (22,6 % et
24,7 % de frames manquées). Le temps
WebDriver inclut la négociation de la session automation (quelques dizaines de ms). Aucune machine
Linux physique ni Wayland n'a été mesurée.

**Ce que ça dit.** En natif, le lancement suivant prend ~1,1 s jusqu'à la liste des fils, plus du
double d'Electron sur macOS (dont ~0,3 à 0,5 s côté page : le reste est le démarrage du processus,
de WebKitGTK et de la session WebDriver), et la mémoire au repos ~750 Mo, au-dessus d'Electron
(660 Mo) : pas de gain mémoire sous Linux. Pendant le streaming, une frame sur cinq manque, en
natif comme en émulation : le goulot est le rendu logiciel de WebKitGTK sous Xvfb (sans GPU), pas
le CPU. Le risque « WebKitGTK lent » (section 7) n'est donc **pas** levé : il faut mesurer une vraie
machine Linux avec GPU avant de remplacer Electron sous Linux. Rien ne bloque pour autant le build :
la console tourne entière, SSE compris. Le délai avant le premier texte dépend surtout du modèle et
de la file du runtime de la VM 240.

**Constats.**
- **Fermer la fenêtre** : avant D2b, un vrai `WM_DELETE_WINDOW` détruisait la fenêtre pendant que
  le tray gardait le processus en vie, sans plus rien à afficher. Depuis D2b (`window.rs`), fermer
  cache la fenêtre sur toutes les plateformes ; le parcours le vérifie sous Linux (point 8) et
  « Quitter » du tray quitte vraiment.
- **Purge des données de la WebView sans confirmation** (relevé par D2b) : sous Linux,
  `clear_all_browsing_data` de wry ne signale pas la fin de `webkit_website_data_manager_clear` ;
  la page suivante se charge après une pause de 500 ms. Écart connu : une confirmation demande
  d'appeler WebKitGTK directement (`with_webview`, crate `webkit2gtk`), non fait en D5.
- Le code macOS de D2b (`#[cfg(target_os = "macos")]`, `src/macos/`) compile sous Linux sans
  retouche : `cargo test` (85 tests) et `clippy -D warnings` passent dans l'image.
- `xdg-open` en mode générique (aucun bureau détecté) ne sait pas lire la ligne `Exec` entre
  guillemets qu'écrit le plugin deep-link ; GNOME et KDE passent par `gio`/`kde-open`, qui la lisent :
  le parcours utilise `gio open`.
- Le processus web de WebKitGTK n'est **pas** sous bubblewrap : wry n'active pas le bac à sable de
  WebKitGTK (aucun appel dans wry 0.57, aucun `bwrap` dans l'arbre des processus mesuré). À décider
  avant une distribution.
- Fermer la session WebDriver ne quitte pas l'app (fenêtre cachée, tray) : le parcours la termine
  lui-même entre deux lancements.
- Les outils du dépôt démarrent par `#!/usr/bin/env node` (vite) : l'image n'a pas Node, `node` y
  est un lien vers Bun.

**CI.** Job `desktop-linux` de `core-ci.yml` (ubuntu-24.04), requis par `core-ci ok` : mêmes
paquets (`linux/install-deps.sh`), Rust 1.98.0, `cargo test`, aller-retour Secret Service sous GNOME
Keyring, `clippy -D warnings`, deb + AppImage **non signés** (aucun secret en CI), puis démarrage de
l'AppImage et du deb installé sous Xvfb jusqu'à la page de connexion (scénario `smoke`, captures
en artefact). Non lancé sur GitHub (pas de push) : ses commandes ont tourné dans l'image
(`bun apps/desktop-tauri/scripts/linux-docker.ts ci`, vert), et `actionlint` (avec shellcheck) passe.
Écart possible avec le runner GitHub (noyau, AppArmor, polices) : à surveiller au premier passage.

**Reproduire.** `make desktop-tauri-linux TAURI_VERSION=1.1.0 [TAURI_LINUX_ARCH=aarch64]`,
`make desktop-tauri-linux-check`, `make desktop-tauri-linux-e2e TAURI_VERSION=1.1.0` (API de
`make dev` et Mailpit), `make desktop-tauri-linux TAURI_VERSION=1.1.1-test` puis
`make desktop-tauri-linux-update TAURI_FROM=1.1.0 TAURI_TO=1.1.1-test` (ces deux dernières sur le
Mac : le conteneur joint l'API, Mailpit et le flux, liés à `127.0.0.1`, par `host.docker.internal`,
que Docker Desktop et OrbStack renvoient vers la boucle locale de l'hôte, pas Docker natif sous
Linux ; le script refuse alors avec un message). L'app lit
`~/.config/app.openedbot.desktop.preview/config.json`.

**Écarts restant pour Linux.**
- Hébergement et canal du flux (Q2) ; dépôt APT ou équivalent pour le deb ; signature des paquets
  (le deb n'est pas signé, l'AppImage n'a pas de signature embarquée, seule la mise à jour l'est).
- Wayland natif, GNOME sans extension AppIndicator (pas d'icône : la fenêtre et le menu restent),
  KWallet, Secret Service verrouillé (une invite peut bloquer le démarrage le temps de la saisie).
- Mesure sur une vraie machine Linux avec GPU ; RPM et Flatpak non faits.
- Le deep link ne fait que ramener l'app au premier plan : le retour de connexion Google viendra
  avec D2b.

### 4.3.4 Mises à jour (D2c, 2026-11-06)

Branche `feat/d2c-update-badge` (et `feat/update-badge` dans openedbot-notch). La mise à jour
devient visible et consentie, sur le modèle de Grok Bot : téléchargement silencieux, pastille
bleue informative, redémarrage seulement sur un clic ou quand le Mac est inactif. La coque ne
redémarre jamais seule pendant qu'on s'en sert. Rien de visible dans la version web (le code
est retiré du build web, vérifié dans le bundle) ; pas de changement de CHANGELOG pour cette
raison.

**Moteur (`update_engine.rs`).** Le flux est un trait (`Feed`) ; `tauri-plugin-updater` en est
l'implémentation (`updater.rs`), les tests utilisent un flux scripté. Une offre est téléchargée
et sa signature vérifiée dès qu'elle paraît, puis gardée en mémoire (`Ready`). L'installation
(`install_update(version)`) ne part que pour la version que l'utilisateur a vue ; elle relit le
flux juste avant : version remplacée (autre numéro, ou même numéro signé à nouveau) → refus
`UPDATE_SUPERSEDED` et téléchargement de la nouvelle ; version retirée → `UPDATE_WITHDRAWN` ;
flux injoignable → refus, le téléchargement est gardé. Puis le popup est arrêté (sortie
attendue), le bundle remplacé, l'app relancée. Une offre refusée sur sa signature n'est plus
retéléchargée par ce processus tant que le flux propose la même (version, signature), et
l'erreur reste affichée. Le pont passe en version 2 (`restart_to_update` retiré).

**États.** Un seul état publié (`UpdateState` : phase, exigence, dernière erreur, réglage,
dernière vérification), au pont et au notch :

| État | App de bureau | Notch |
|---|---|---|
| Au repos, recherche, version annoncée | Rien | Rien |
| Téléchargement | Indicateur discret à la place de la pastille (pourcentage en infobulle) | Rien |
| Prête | Pastille bleue « Mettre à jour » (infobulle « openedbot X.Y.Z est prête »), ligne « Nouvelle mise à jour disponible » du menu du compte, menu de l'app « Redémarrer pour mettre à jour » | Point bleu ; déplié : « Mise à jour prête » |
| Installation | Dialogue « Redémarrage… », menu de l'app désactivé | Point bleu |
| Erreur | Seulement dans Réglages › Mises à jour (« Dernière erreur ») | Rien |
| Requise (426 de l'API, `min_version` ou `max_age_days` du manifeste) | Écran « Mise à jour requise » à la place de l'app : « Mettre à jour maintenant » (progression, avertissement si des runs tournent), lien de téléchargement en repli | Point bleu ; déplié : « Mise à jour requise » |

Le clic sur la pastille, la ligne du menu du compte, Réglages ou le menu de l'app ouvre
« Mise à jour prête » (« Redémarrer » / « Plus tard »). S'il reste des runs en cours, le
dialogue attend (« En attente de la fin de N run(s)… ») et propose « Redémarrer quand même ».
Le clic sur le notch ouvre Réglages › Mises à jour ; le notch ne redémarre jamais rien. Couleur
fixe, pas l'accent de l'app : depuis D3b, le bleu des mises à jour d'Apple (`--update-accent`,
section 4.3.7) au lieu de `--state-info-*`.

**Inactivité.** Réglage « Installer quand le Mac est inactif », actif par défaut (préférences de
la coque). Conditions : écran verrouillé, économiseur d'écran ou 10 minutes sans entrée
(`CGEventSourceSecondsSinceLastEventType`, notifications `com.apple.screenIsLocked` et
`com.apple.screensaver.didstart`), aucune exécution en cours selon la console, une version
prête. Les conditions sont relues après la relecture du flux et après l'arrêt du popup ; si
elles ne tiennent plus, le popup repart et la version reste prête. Hors macOS, jamais inactif.

**Requise, deux sources.** Le 426 de l'API (`DESKTOP_MIN_VERSION`) : la console appelle
`report_update_required`, la coque vérifie le flux aussitôt. Le manifeste : `min_version`, et
`max_age_days` comparé à l'heure de build embarquée (`OPENEDBOT_BUILT_AT`). Le plancher du
manifeste ne s'applique que s'il propose une version plus récente.

**Cadence.** Première vérification 30 s après le lancement, puis toutes les heures plus 0 à
5 minutes au hasard, au réveil, sur un 426 et à la demande (Réglages, menu de l'app).
`OPENEDBOT_UPDATE_CHECK_SECONDS` et `OPENEDBOT_UPDATE_IDLE_SECONDS` raccourcissent les délais
pour les tests.

**Linux (D5).** Un deb n'a pas de moteur de mise à jour (« not an AppImage »). Le scénario
`update` de `linux-e2e.ts` consent désormais par `install_update` (WebDriver) au lieu d'attendre
un redémarrage spontané ; il n'a pas été rejoué ici.

**Vérifié sur l'app signée et notarisée** (`app.openedbot.desktop.preview`, `spctl` :
`Notarized Developer ID`), API locale de `make dev` et flux local bridé à 250 Ko/s, captures
hors dépôt. 0.0.19 installée, puis : à jour (rien) ; 0.0.20 publiée : indicateur de
téléchargement, pastille claire et sombre, point bleu du notch, Réglages, dialogue, « Plus
tard » (l'app continue) ; 0.0.21 publiée dialogue ouvert puis « Redémarrer » : refus « version
plus récente », la 0.0.21 se télécharge ; 0.0.21 retirée (`--announce 0.0.1`) puis
« Redémarrer » : refus « n'est plus proposée » ; signature forgée : refusée, erreur dans
Réglages ; un vrai run de Websearch en cours : « En attente de la fin de 1 run… », puis
redémarrage en 0.0.20 à la fin du run, session et popup repris, plus de point bleu ;
`min_version` 0.0.21 : écran requis, installé en 0.0.21 ; `max_age_days` : écran requis avec
pourcentage, installé en 0.0.22 ; signature forgée sur la 0.0.22 corrigée : téléchargée une
fois, l'erreur reste ; inactivité (seuil 20 s, aucune entrée) : installé en 0.0.23 ; un run en
cours retient l'installation (« idle install waits: 1 run(s) in progress »), qui part après le
run (0.0.24) ; API à `DESKTOP_MIN_VERSION=0.0.24` : écran requis, rien de plus récent, lien de
téléchargement ; menu de l'app « Rechercher des mises à jour… », puis « Redémarrer pour mettre à
jour », qui ouvre le dialogue sans redémarrer, installé en 0.0.25 ; pastille puis
« Redémarrer » : 0.0.26, la dernière. Les builds 0.0.16 à 0.0.18 ont été jetés (code d'avant les
revues), jamais publiés.

**Non éprouvé à l'écran, couvert par des tests.** Verrouillage et économiseur d'écran (pas de
faux verrouillage envoyé aux autres apps), réveil, translocation, infobulle de la pastille, ligne
du menu du compte (absente de la disposition à rail de l'org de dev), notch déplié et clic sur le
notch.

**Constats.**
- Le serveur de flux local perdait `Content-Length` sur un téléchargement bridé (`Bun.serve`) :
  pas de pourcentage. Il passe par `node:http`.
- Après la fin d'un run, l'installation à l'inactivité peut attendre jusqu'à un rafraîchissement
  du roster (60 s) : le compte des runs vient de la console.
- Après un redémarrage, la console rouvre sur l'accueil, pas sur le fil ouvert.

**Écarts restants.**
- Installation à la sortie de l'app (Grok Bot le fait) : non faite.
- Hébergement et canaux du flux (Q2), comme avant.
- Le notch rejette une version suffixée (`1.1.1-test`) dans `updateState` : la ligne est
  ignorée, sans point bleu.
- +1,5 Ko gzip au premier chargement (textes), 372,3 / 380 Ko.

**Reproduire.** `make desktop-tauri-mac TAURI_VERSION=X.Y.Z TAURI_POPUP=…`, puis
`bun apps/desktop-tauri/scripts/update-feed.ts serve --slow-kbps 250` et
`… publish --version X.Y.Z [--announce A.B.C] [--forged-signature] [--min-version V]
[--max-age-days N]`.

### 4.3.5 Release et bascule macOS (D3, 2026-11-06)

Branche `feat/d3-macos-release`. L'app Tauri devient **openedbot 1.1.0** pour Mac et remplace
l'app Electron. Tout est prêt à publier ; **rien n'est publié** (ni R2, ni GitHub, ni tag, ni
lien du site) : la publication attend l'accord de l'utilisateur.

**Identité de production.** `build-mac.ts --identity production` (`make desktop-tauri-mac
TAURI_IDENTITY=production`) applique `src-tauri/tauri.production.conf.json` : identifiant
`app.openedbot.desktop` et nom « openedbot », ceux d'Electron (`apps/desktop/electron-builder.yml`,
vérifié par un test), exécutable `openedbot`, schéma `openedbot://` déclaré. La coque lit son
identité dans la configuration compilée (`identity.rs`) : service Keychain, `clientId` OAuth
(`openedbot-desktop-macos`), noms des menus et dialogues, fichier de journal (`openedbot.log`).
Le build vérifie l'`Info.plist` produit (identifiant, nom, exécutable, schéma) et refuse sinon.
La preview reste le défaut, installable à côté d'Electron. Les builds de test portent un
suffixe (`1.1.1-test`) : un numéro n'est jamais réutilisé.

**Données à la bascule (Q1), sans collision.** Electron garde sa session dans
`~/Library/Application Support/openedbot` (fichier chiffré par `safeStorage`, clé dans l'item
Keychain « openedbot Safe Storage »). L'app Tauri utilise `~/Library/Application Support/app.openedbot.desktop`,
`~/Library/WebKit/app.openedbot.desktop`, `~/Library/Caches/app.openedbot.desktop`,
`~/Library/Logs/app.openedbot.desktop` et l'item Keychain de service `app.openedbot.desktop`
(compte par origine d'API). Aucun chemin commun, et la coque ne lit jamais les données
d'Electron : au premier lancement l'app est déconnectée (une reconnexion), les brouillons
(localStorage de la console distante) ne sont pas repris, et les deux apps n'ont jamais le même
refresh token (deux connexions distinctes, deux lignées). Seul fichier partagé par l'identifiant :
`~/Library/Preferences/app.openedbot.desktop.plist` (NSUserDefaults) ; la coque Tauri n'y écrit
pas (la preview n'a jamais créé le sien), vérifié par sa date et sa taille avant et après les essais.
Le refresh token d'Electron reste dans son dossier jusqu'à son expiration côté serveur ; il n'est
plus utilisé une fois l'app remplacée.

**Flux de mise à jour hébergé (Q2), proposé.** Le bucket R2 d'edge-setup, servi par
`https://releases.openedbot.app` :

```
 releases.openedbot.app/desktop/
   v1.1.0/                                  immuable, jamais réécrit
     openedbot_1.1.0_aarch64.dmg
     openedbot_1.1.0_aarch64.app.tar.gz     artefact de mise à jour
     openedbot_1.1.0_aarch64.app.tar.gz.sig signature minisign (clé hors de l'hébergement)
     SHA256SUMS
   solo/                                    variante (Q8)
     beta/latest.json                       manifeste du canal bêta
     stable/latest.json                     manifeste du canal stable (promotion)
```

L'app de production lit `desktop/solo/stable/latest.json` par défaut, `beta` avec
`"updateChannel": "beta"` dans `config.json` (ou `OPENEDBOT_UPDATE_CHANNEL`) ; un canal inconnu
est une configuration refusée. `updateUrl` reste prioritaire (flux local des essais). Le manifeste
liste les architectures (`darwin-aarch64` aujourd'hui) ; il s'écrit en dernier, après les fichiers
qu'il nomme. Le domaine sert le JSON en `Cache-Control: public, max-age=60` (relu le
2026-11-06) : une nouvelle version peut mettre une minute à apparaître, ce que le moteur tolère
(il relit le flux avant d'installer). `make desktop-tauri-release TAURI_VERSION=X.Y.Z`
(`release-mac.ts`) rassemble ces fichiers depuis un build de production notarisé, sans rien
envoyer.

**Pipeline GitHub.** `desktop-release.yml` ne construit plus Electron pour macOS : sur un tag
`desktop/vX.Y.Z`, le job `mac` télécharge le dmg publié sur R2, vérifie sa somme, Gatekeeper,
le ticket agrafé, l'identifiant et la version, puis le joint à la release GitHub sous
`openedbot-mac-arm64.dmg`, le nom que le site lie (`releases/latest/download/…`). Sans dmg sur
R2 pour cette version, le job échoue et rien n'est publié. Linux garde Electron (même tag, même
numéro). La clé de mise à jour ne quitte pas le Mac : le build signé se fait en local.
`actionlint` (avec shellcheck) ne relève rien de nouveau.

**Comment les utilisateurs d'Electron reçoivent la 1.1.0.** Electron 1.0.x n'a **aucun**
mécanisme de mise à jour (pas d'electron-updater, `electron-builder.yml` : « No auto-update
feed ») : il n'y a pas de flux Squirrel à détourner, donc ni zip ni `latest-mac.yml` de
bascule. Deux chemins :
1. le site : `releases/latest/download/openedbot-mac-arm64.dmg` sert la 1.1.0 dès que la release
   `desktop/v1.1.0` est la dernière ; le dmg se glisse sur l'ancienne app (même nom), le
   Finder propose de la remplacer ;
2. l'app Electron elle-même : elle charge la console web distante, qui peut donc lui parler.
   Une pastille « Nouvelle app » (`electron-switch.tsx`, même bleu que la pastille de mise à
   jour) ouvre la page de téléchargement, seulement dans Electron sur Mac, avant 1.1.0. Elle est
   éteinte (`ELECTRON_MAC_SWITCH_LIVE = false`, rien dans le build web) : la publication
   l'allume, puis déploie la console web.
`DESKTOP_MIN_VERSION` ne sert pas à forcer la bascule : Electron annonce `desktop/1.0.3` sans
plateforme, et couperait aussi Windows et Linux, qui restent sous Electron.

**Perte de la clé de mise à jour (risque, section 5).** La clé minisign
(`~/.config/openedbot-tauri-updater/`, 0700/0600) n'est ni dans le dépôt ni sur R2, ni en CI.
Procédure écrite pour D3 : (1) une copie chiffrée hors de ce Mac (coffre de mots de passe de
l'utilisateur, avec sa phrase de passe à part) — à faire avant la publication de la 1.1.0, non
faite ici ; (2) rotation prévue : une version N signée par l'ancienne clé embarque la nouvelle
clé publique, puis N+1 est signée par la nouvelle ; (3) clé perdue sans copie : plus aucune
mise à jour automatique possible, les utilisateurs réinstallent depuis le dmg (lien de l'écran
« Mise à jour requise » et du site), et `DESKTOP_MIN_VERSION` sur l'API pousse les retardataires
vers ce lien. L'exercice de rotation n'a pas été fait.

**Version qui plante après une mise à jour (risque, section 5).** Pas de retour arrière
automatique : le bundle précédent est remplacé. Parade : canal bêta d'abord (testeurs avec
`updateChannel: beta`), promotion en stable après vérification ; une version stable cassée se
corrige en publiant N+1 (le moteur se relance au démarrage, 30 s après) ou, si l'app ne démarre
plus, par le dmg de la version précédente, toujours servi sous `desktop/vX.Y.Z/` (immuable). Un
retour arrière automatique (garder `openedbot.app` précédent jusqu'à un premier démarrage
réussi) reste à concevoir.

**Étapes de publication (en attente d'accord, rien n'est fait).** Remplacées par celles de la
section 4.3.6 (D6 : Linux en Tauri, plus d'Electron, plus d'annonce dans Electron).
1. Commit de release sur `develop` puis `main` : `apps/desktop/package.json` en 1.1.0 (le tag
   doit correspondre, Linux Electron est reconstruit au même numéro), `CHANGELOG.md` « Non
   publié » → `## 1.1.0 — <date>`.
2. Copie chiffrée de la clé de mise à jour hors du Mac (voir plus haut).
3. R2, depuis le Mac (jeton Cloudflare à droits R2, jamais en argument) : les quatre fichiers
   de `artifacts/desktop-1.1.0/macos/` sous `desktop/v1.1.0/` (dmg, `.app.tar.gz`, `.sig`,
   `SHA256SUMS` en dernier), relus depuis `https://releases.openedbot.app/desktop/v1.1.0/` et
   comparés à `SHA256SUMS`.
4. Canal bêta : `manifests/beta/latest.json` → `desktop/solo/beta/latest.json`. Une app 1.1.0
   configurée en bêta (`updateChannel: beta`) ne voit rien de plus récent ; la première vraie
   épreuve du flux hébergé sera la 1.1.1.
5. Tag `desktop/v1.1.0` poussé : `desktop-release.yml` reconstruit Linux, recopie le dmg depuis R2
   après vérification et publie la release GitHub (`--latest`). Le site (`openedbot-site`,
   `releases/latest/download/openedbot-mac-arm64.dmg`) sert alors la 1.1.0 sans changement de
   code ; vérifier la page `/download` et `/fr/download`.
6. Promotion stable : `manifests/stable/latest.json` → `desktop/solo/stable/latest.json`.
7. Annonce dans Electron : `ELECTRON_MAC_SWITCH_LIVE = true`
   (`apps/console/src/components/desktop-update/entry.ts`, test à mettre à jour), puis
   déploiement de la console web.

**Construit (2026-11-06, develop 6902337 + cette branche jusqu'au correctif des feux tricolores, popup du notch `feat/update-badge` 34dcdca).**
arm64 seulement. Developer ID, hardened runtime, aucun entitlement, popup re-signé de l'intérieur ;
app notarisée et agrafée (64 s), dmg signé, notarisé et agrafé (28 s). Gardés hors du dépôt
(`artifacts/desktop-1.1.0/macos/`) :

| Fichier | Taille | sha256 |
|---|---|---|
| `openedbot_1.1.0_aarch64.dmg` | 19 568 233 o | `93ef1dc0c46d25c7343002b63ced6c28ece3098de4ea0cca9ced2ae92cec70fa` |
| `openedbot_1.1.0_aarch64.app.tar.gz` | 19 778 636 o | `3282fd17ae475eec53223cdcdbbae3f47d5c64167b0bf2f69fa0db648fa5567c` |
| `openedbot_1.1.0_aarch64.app.tar.gz.sig` | 428 o | `ad2f8015dda0b56573ca941700525d524de9f1443d8be3f0c8e86e1674d33556` |

Vérifié : `codesign --verify --deep --strict` valide ; `spctl -a -vv` sur l'app : `accepted,
source=Notarized Developer ID` ; dmg marqué `com.apple.quarantine` : `spctl -a -t open --context
context:primary-signature` → `accepted, source=Notarized Developer ID` ; `stapler validate` sur l'app
et le dmg ; copié dans `/Applications/openedbot.app` (il n'y en avait pas) : accepté, notarisé,
`Identifier=app.openedbot.desktop`, `TeamIdentifier=QDC76LMF29`. Ces vérifications ont été refaites sur ce
build reconstruit (même numéro, jamais publié) après le correctif des feux tricolores ; le build d'avant,
sur lequel portent G1, G3 et la mise à jour réelle ci-dessous, reste dans `release/1.1.0-superseded/`.
Deux builds de test,
`1.1.1-test` (notarisé, cible de la mise à jour), `1.1.2-test` (non notarisé, autre build id de
la console, build B de G1) et `1.1.3-test` (non notarisé, mise au point des feux tricolores), jamais publiés.

`OPENEDBOT_API_ORIGIN=http://example.com` sur le 1.1.0 installé : alerte « Configuration
refusée » (texte avec la variable et le chemin de `config.json`), puis sortie ; journal
`configuration refused: OPENEDBOT_API_ORIGIN must be https…`. Cette alerte, montrée à l'écran
pendant une session de l'utilisateur, a été prise pour une erreur : les essais suivants à l'écran
ont été suspendus à sa demande.

Les essais à l'écran ont repris avec l'accord de l'utilisateur, sur le 1.1.0 installé dans
`/Applications`, connecté une fois par le relais d'API (API locale seulement).

**G1 et G3 sur l'app signée (2026-11-06).** `apps/desktop-tauri/scripts/perf/perf-mac.ts`, M5 Pro,
macOS 26.6.2 ; A = 1.1.0 notarisé dans `/Applications`, B = 1.1.2-test (autre build id de la
console) ; relais d'API local, sans délai puis avec 50 ms ; 5 essais par cas, 3 pour G3, aucun
échec. Le marqueur est celui de D0 (premier lien `a[href*="/bot/"]` visible), lu par l'arbre
d'accessibilité de WKWebView (`ax-marker.swift`, interrogé en boucle) : la sonde ajoute un coût
que la mesure CDP d'Electron n'avait pas, les chiffres sont donc plutôt pessimistes. Résultats
bruts, non versionnés : `tmp/perf/d3-2026-11-06T19-08-34-460Z.json`.

| Mesure | Electron 1.0.3 (D0) | Tauri 1.1.0 signé | Cible | Verdict |
|---|---|---|---|---|
| G1 premier lancement, local / réseau simulé | 564 / 1 399 ms | 604 / 1 256 ms | ≤ 600 ms | Manquée de peu en local, nettement en réseau simulé |
| G1 lancement suivant, local / réseau simulé | 452 / 573 ms | 540 / 637 ms | ≤ 450 ms | Manquée, et plus lent qu'Electron |
| G1 après mise à jour, local / réseau simulé | 482 / 987 ms | 557 / 754 ms | ≤ 600 ms | Atteinte en local, manquée en réseau simulé (−24 % face à Electron) |
| G3 mémoire au repos, fil ouvert depuis 30 s | 660 Mo, 4 processus | 456 Mo, 4 processus (app ≈ 120 Mo, WebKit 295 à 450 Mo) | ≤ 330 Mo | Manquée, −31 % face à Electron |

Lecture : la mémoire baisse d'un tiers sans atteindre la moitié visée. Au lancement, la coque
native ne fait pas gagner de temps en local ; en réseau simulé, elle gagne au premier lancement et
après une mise à jour, où la console part d'un cache froid, et perd au lancement suivant. Le
premier essai « après mise à jour » (1 088 ms) est le premier lancement du build B, non notarisé :
l'évaluation de Gatekeeper y entre, la médiane l'écarte. En réseau simulé, l'écart vient des
appels d'API en cascade au démarrage de la console (même constat qu'en D1b), pas de la coque.
Les cibles restent ouvertes : elles ne bloquent pas la bascule (mémoire et premier lancement en
réseau meilleurs qu'Electron), mais le lancement suivant est à reprendre côté console (requêtes
parallèles, cache persistant servi avant le réseau).

**Mise à jour réelle sur l'identité de production (2026-11-06).** `config.json` de l'app vers
l'API locale et un flux local (`update-feed.ts`), notch actif :
- 1.1.0 → 1.1.1-test : premier contrôle à 30 s, téléchargement de 19 779 989 o, journal
  `signature verified: ready` ; point bleu dans le notch (`notch-dot-update.png`) ; pastille
  « Mettre à jour », dialogue « Mise à jour prête » puis « Redémarrer » ; popup arrêté avant le
  remplacement ; relancé en 1.1.1-test en moins d'une seconde, session reprise sans reconnexion.
  Après coup, `/Applications/openedbot.app` : `CFBundleShortVersionString` 1.1.1-test, `spctl` →
  `accepted, source=Notarized Developer ID`, `stapler validate` valide, `TeamIdentifier=QDC76LMF29`,
  hardened runtime.
- Manifeste 1.1.2-test signé par une autre clé, contrôle demandé par le menu : journal
  `update 1.1.2-test refused: bad signature (… different key …)`, réglages « La signature de la
  mise à jour a été refusée : rien n'a été installé. », app restée en 1.1.1-test ; au contrôle
  suivant, le même manifeste n'est pas retéléchargé.

**Autres preuves à l'écran.**
- `openedbot://` : Launch Services liste `/Applications/openedbot.app` parmi les gestionnaires du
  schéma. Sur ce Mac, le gestionnaire par défaut reste l'Electron de développement
  (`apps/desktop/node_modules/electron`), qui n'a pas été touché : l'URL
  `openedbot://auth/callback` a donc été remise à l'app installée par `open -g -a` (sans
  l'activer), app masquée ; elle est revenue au premier plan par son gestionnaire de deep link,
  une seule instance. Chez un utilisateur, le 1.1.0 remplace Electron au même chemin et sous le
  même identifiant : pas de concurrence.
- Changement de backend : thème « Sombre » choisi sur l'API du relais (port 4180), relance sur
  l'API 8790 : journal `WebView data of another backend purged`, page de connexion toujours en
  sombre (`theme-after-backend-change.png`).
- Déconnexion : jetons révoqués, données WebView purgées (journal).
- Restent non éprouvés à l'écran (tests seulement) : raccourci global repris au focus,
  presse-papiers, clic sur une notification, copie sur un champ mot de passe.
- La date et la taille de `~/Library/Preferences/app.openedbot.desktop.plist` (Electron) sont
  inchangées après les lancements du 1.1.0 (149 o, 28 oct.).

Captures, non versionnées : `/tmp/d3-evidence/`.

**Feux tricolores (2026-11-06, retour de l'utilisateur).** Sur le 1.1.0 d'avant, le centre des
feux était à 14 pt du haut à tous les zooms (l'inset de tao `{16, 16}` ne vaut pas celui
d'Electron), la barre du haut à 23 × zoom pt. Mesuré après correction sur le build signé, par
l'arbre d'accessibilité (cadres des boutons et du bouton « Masquer la barre latérale ») et sur
les captures (centre des pixels rouges du bouton de fermeture, centre de l'encre de l'icône de la
barre) :

| Zoom | Centre de la barre (23 × zoom) | Feux, AX / capture | Icône de la barre, AX / capture | Écart vert → logo |
|---|---|---|---|---|
| 0,71 (texte 10 px) | 16,43 pt | 16,50 / 16,25 pt | 16,50 / 16,25 pt | 10,0 pt |
| 0,86 (texte 12 px) | 19,71 pt | 19,50 / 19,25 pt | 19,50 / 19,50 pt | 12,0 pt |
| 0,91 (Zoom Out) | 20,91 pt | 21,00 / 20,75 pt | 21,00 / 21,00 pt | 12,5 pt |
| 1,00 | 23,00 pt | 23,00 / 22,75 pt | 23,00 / 22,75 pt | 14,0 pt |
| 1,10 (Zoom In) | 25,30 pt | 25,50 / 25,25 pt | 25,00 / 24,75 pt | 15,0 pt |
| 1,21 | 27,83 pt | 28,00 / 27,75 pt | 28,00 / 27,50 pt | 16,5 pt |
| 1,33 | 30,61 pt | 30,50 / 30,25 pt | 30,50 / 30,75 pt | 22,5 pt |

Clair et sombre identiques ; à 1,21 après un redimensionnement (1 100 × 720) et après un aller-retour
en plein écran : 28,00 pt. Le feu vert finit à 76 pt à tout zoom ; de 0,71 à 1,21, l'écart jusqu'au
logo vaut 14 px de page (`native-titlebar.css` réserve 76 / zoom), la géométrie d'Electron. À 1,33,
il passe à 22,5 pt (17 px de page) : le logo se décale, sans chevauchement. Le CSS est celui
d'Electron ; cet écart n'a pas été comparé dans Electron. Captures avant / après,
non versionnées : `/tmp/d3-evidence/lights/` (`before-*.png`, `after-*.png`). Le correctif ne touche
que la coque native : G1 et G3 ont été mesurés sur le 1.1.0 d'avant et n'ont pas été remesurés
(quelques cadres AppKit posés à l'ouverture, sans effet attendu sur le temps ni la mémoire).

**Écarts de D2b, état à la fin de D3.**

| Écart | État | Preuve ou raison |
|---|---|---|
| Schéma `openedbot://` au remplacement d'Electron | Fait | Déclaré par l'overlay de production, relu dans l'`Info.plist` du 1.1.0 par `build-mac.ts` ; le retour Google passe par le deep link (`identity.declares_scheme`) |
| Manifeste par canal et variante, hébergement (Q2) | Préparé | Disposition ci-dessus, `release-mac.ts`, manifestes beta et stable du 1.1.0 ; rien d'envoyé |
| Configuration invalide | Fait | Dialogue « Configuration refusée » (fichier ou variable en cause), puis sortie 78 ; non bloquant pour la boucle d'événements (revue Codex). Vu sur le 1.1.0 signé |
| Changer de backend efface thème et taille du texte | Fait | Le lancement sur un autre backend lit d'abord les préférences de l'appareil depuis une page vide de l'origine locale (`/__openedbot/empty`), puis purge et les réécrit, comme à la déconnexion. Thème sombre gardé à l'écran de 4180 à 8790 |
| Raccourci global déjà pris | Fait en partie | Redemandé à chaque prise de focus de la fenêtre, journalisé une fois. Limite : `RegisterEventHotKey` sans option exclusive ne signale pas toujours un raccourci déjà pris par une autre app ; Electron, remplacé au même endroit, ne tourne plus après la bascule |
| Silhouette de démarrage | Fait | Le script inline de `index.html` voit `__OPENEDBOT_SHELL__` (posé avant tout script) ; barre macOS d'après la plateforme de la coque. Test `boot-silhouette.test.ts` |
| Point bleu du notch sur une version de test | Fait | La coque n'envoie plus au notch une version suffixée (`1.1.1-test`) : elle part sans numéro, le point s'affiche (vu à l'écran pendant la mise à jour 1.1.0 → 1.1.1-test) |
| Feux tricolores déplacés selon le zoom | Fait | Ni `traffic_light_position` (fixé à la construction) ni l'inset de tao (réappliqué à chaque `drawRect:`) : la coque ne pose aucun inset et place elle-même les boutons, comme le `WindowButtonsProxy` d'Electron (`macos/traffic_lights.rs`) : conteneur de la barre de titre haut de 46 × zoom points, boutons centrés dedans, calés sur le pixel. Réappliqué à chaque zoom et dès qu'AppKit déplace le bouton de fermeture ou le conteneur (redimensionnement, sortie du plein écran, apparence). Voir « Feux tricolores » ci-dessus |
| Copie interdite sur un champ mot de passe, `navigator.clipboard`, clic sur une notification | Reste | Non éprouvés à l’écran, tests seulement (voir plus haut) |
| Google réel | Reste | Pas d'identifiants OAuth en local |
| Linux et Windows : purge sans confirmation | Reste | Hors macOS (D4, D5) |
| Universel ou x86_64 | Non fait | arm64 seul, comme Electron 1.0.3 : le popup du notch n'est construit qu'en arm64 (`make bundle`), et aucun Mac Intel pour l'essayer |

### 4.3.6 Retrait d'Electron (D6, 2026-11-06)

Branche `chore/d6-remove-electron`. Décisions de l'utilisateur : Electron supprimé sans trace
(code, build, CI, Makefile, docs, tests) ; **Windows retiré du site et des releases** jusqu'à
une app Tauri pour Windows (D4) ; **Linux publié en Tauri** (deb et AppImage, x86_64 et
aarch64), malgré le risque WebKitGTK de la section 7, qui reste à mesurer sur une vraie machine.
Rien n'est publié par cette étape (ni R2, ni tag, ni release).

**Retiré.** `apps/desktop` entier (coque, tests, scripts, design lab, maquettes,
`electron-builder*.yml`, son `bun.lock` ; ce n'était pas un workspace, le `bun.lock` racine ne
change pas) ; `make desktop` et l'arrêt d'Electron dans `make stop` ; l'exclusion `^apps/desktop/`
de dependency-cruiser ; le mode Electron de `d0-baseline.ts` (le web reste, l'app se mesure par
`perf-mac.ts`) ; dans la console, la pastille « Nouvelle app » de D3 (`electron-switch.tsx`,
`desktop-switch.ts`, textes `desktopSwitch`, jamais allumée), la lecture de la plateforme dans
l'agent utilisateur (`native-titlebar.ts`, `index.html`) et le repli de `publicConsoleOrigin`
sur l'origine web de la page. Les icônes passent dans `apps/desktop-tauri/src-tauri/icons/`. Les
commentaires qui renvoyaient à Electron décrivent le comportement lui-même. Restent comme
histoire : ce document, les sections publiées du `CHANGELOG.md`, l'historique git.

**Le pont n'existe que dans le build desktop.** `nativeBridge()` rend `null` dans le build web,
quoi que la page hôte pose sur `window.__OPENEDBOT_NATIVE__` : `VITE_OPENEDBOT_SHELL` est remplacé
au build, et le nom du pont n'apparaît plus dans le bundle web (vérifié). Le script de démarrage
de `index.html` ne croit que `__OPENEDBOT_SHELL__`, que seule la coque Tauri pose. Les tests qui
simulent la coque passent par `apps/console/tests/support/desktop-build.ts`.

**Une app 1.0.x (Electron) après le déploiement de la console web.** Elle n'a aucun mécanisme de
mise à jour et charge la console distante (`${consoleUrl}/` avec une session, `/login` sans), son
preload posant l'ancien pont. La console la sert désormais comme un navigateur. Prouvé dans
Chromium sur le build web de cette branche, pont de la 1.0.3 simulé avant tout script (gelé,
`platform: "windows"`, `version: "1.0.3"`, `auth`) : `/` et `/compact` redirigent vers `/login`
web, aucun appel au pont, aucune requête avec `Authorization` ni `X-OpenedBot-Client`, ni
`data-native-titlebar` ni silhouette, aucune erreur de page ; la connexion web par code e-mail
ouvre la console (cookie), rechargement compris. Déduit du code de la 1.0.3 (`window.ts`,
`main.ts`, `ipc.ts` au commit 21a8337 ; l'app 1.0.3 n'a pas été lancée : au démarrage elle se
déclare gestionnaire d'`openedbot://` auprès de Launch Services, ce qui aurait touché le Mac de
l'utilisateur) :
- **session ouverte** (le cas courant) : l'app charge `/`, la console affiche sa page de
  connexion web ; 10 s après le chargement, faute d'appel au pont (`BRIDGE_PROBE_MS`), l'app
  remplace la page par sa propre page de connexion avec « La console openedbot.app ne prend pas
  encore en charge l'application de bureau… ». S'y connecter recharge la console, et le cycle
  recommence. Ni plantage ni écran blanc, mais une impasse ;
- **déconnectée** (ou après « Se déconnecter » dans le menu de l'icône, puis une relance de l'app) :
  l'app charge `/login`, la connexion web par code e-mail fonctionne et la console reste utilisable
  comme dans un navigateur (pas de sonde dans cet état). Google s'ouvre dans le navigateur du
  système et ne revient pas dans l'app ;
- sur Mac les feux tricolores recouvrent le coin haut gauche de la console, sur Windows les boutons
  le coin haut droit, et la barre du haut ne déplace plus la fenêtre : la console ne réserve plus
  leur place ;
- la sortie prévue est le nouveau téléchargement (Mac, Linux) ; sous Windows, la console web dans
  le navigateur (ou la déconnexion puis la connexion web ci-dessus). `DESKTOP_MIN_VERSION` ne
  s'applique pas : la console n'envoie plus l'en-tête client depuis l'ancienne app.

**Linux de production.** `build-linux.ts --identity production` (`make desktop-tauri-linux
TAURI_IDENTITY=production`) applique l'overlay de production comme sur macOS : paquet `openedbot`,
`/usr/bin/openedbot`, `openedbot://` dans l'entrée `.desktop`, données sous
`~/.config/app.openedbot.desktop`, artefacts `openedbot_<version>_<arch>.{deb,AppImage}` ;
`build-linux.ts` relit le paquet produit (nom, version, binaire, schéma, `Replaces` et
`Conflicts`) et refuse sinon. Le deb de la 1.0.x s'appelait `openedbot-desktop` et partage
`/usr/share/applications/openedbot.desktop` et les icônes `openedbot.png` : le deb de production
déclare `Replaces` et `Conflicts: openedbot-desktop` (`tauri.production.conf.json`), sans quoi son
installation échouerait sur ces fichiers. Les liens profonds de production (`openedbot://`)
ramènent l'app au premier plan comme ceux de la preview (`linux.rs`). La preview reste le défaut,
et le parcours `linux-e2e.ts` la vise.
Éprouvé dans `ubuntu:24.04` (amd64) avec le deb 1.0.3 publié (`openedbot-linux-amd64.deb`, somme
vérifiée) puis un build de production de cette branche (`1.1.0-d6`, non signé) : par
`apt install ./openedbot_…deb`, apt retire `openedbot-desktop` et installe `openedbot` en une
passe ; par `dpkg -i`, le paquet est déballé, `openedbot-desktop` retiré, et seules les
dépendances WebKitGTK manquent jusqu'à `apt -f install`. Dans les deux cas : `/usr/bin/openedbot`
est le binaire Tauri (ELF, plus le lien d'alternatives vers `/opt/openedbot`, que le retrait de
la 1.0.3 supprime), l'entrée `.desktop` et les icônes appartiennent à `openedbot`, `/opt/openedbot`
a disparu ; il ne reste de la 1.0.3 que l'état `config-files` dans dpkg.

**Release multiplateforme.** `make desktop-tauri-release TAURI_VERSION=X.Y.Z` (`release.ts`,
anciennement `release-mac.ts`) rassemble le build macOS de production notarisé et les deux builds
Linux de production signés dans `apps/desktop-tauri/release/X.Y.Z/publish/`, disposé comme le
préfixe `desktop/` du bucket :

```
 publish/
   vX.Y.Z/                               -> desktop/vX.Y.Z/   (immuable)
     openedbot_X.Y.Z_aarch64.dmg
     openedbot_X.Y.Z_aarch64.app.tar.gz  (+ .sig)   mise à jour darwin-aarch64
     openedbot_X.Y.Z_x86_64.deb
     openedbot_X.Y.Z_x86_64.AppImage     (+ .sig)   mise à jour linux-x86_64-appimage
     openedbot_X.Y.Z_aarch64.deb
     openedbot_X.Y.Z_aarch64.AppImage    (+ .sig)   mise à jour linux-aarch64-appimage
     SHA256SUMS                          les neuf fichiers, envoyé en dernier
   solo/beta/latest.json                 -> desktop/solo/beta/latest.json
   solo/stable/latest.json               -> desktop/solo/stable/latest.json (promotion)
   records/, RELEASE_NOTES.md            gardés en local
```

Chaque manifeste nomme les trois plateformes ; sous Linux, seule l'AppImage se met à jour (clé
`-appimage` : un deb n'y trouve rien et reste au gestionnaire de paquets). Avant d'écrire un
manifeste, `release.ts` vérifie chaque `.sig` avec la moitié publique de la clé de mise à jour,
désormais dans le dépôt (`apps/desktop-tauri/updater.pub`, la clé que chaque app embarque déjà),
par `minisign.ts` (Ed25519 sur BLAKE2b-512, format de `tauri signer`, sans l'outil minisign ;
éprouvé sur les artefacts signés de D3 et D5) : une signature d'une autre clé, ou d'une autre
version (`version:` du commentaire de confiance), est refusée.

**Pipeline GitHub.** `desktop-release.yml` ne construit plus rien : sur un tag `desktop/vX.Y.Z`
(ou une relance sur ce tag), il télécharge les fichiers que `SHA256SUMS` liste sur R2, lance
`release.ts verify` (liste exacte, sommes, signatures de mise à jour), vérifie le dmg (Gatekeeper,
ticket agrafé, équipe QDC76LMF29, identifiant, version), les debs (paquet, version, architecture,
`Replaces`/`Conflicts`, schéma) et démarre deb installé puis AppImage sous Xvfb sur un runner de
chaque architecture (`ubuntu-24.04`, `ubuntu-24.04-arm`), puis publie la release sous des noms
stables : `openedbot-mac-arm64.dmg`, `openedbot-linux-amd64.deb`,
`openedbot-linux-x86_64.AppImage` (ceux que le site lie déjà), `openedbot-linux-arm64.deb`,
`openedbot-linux-aarch64.AppImage`, et `SHA256SUMS`. Plus de fichier Windows. Aucun fichier ne
porte plus le numéro de version de l'app : le tag, `TAURI_VERSION` et les artefacts doivent
concorder, ce que vérifient la version du dmg, celle des debs et celle des signatures.

**Étapes de publication (remplacent celles de 4.3.5 ; rien n'est fait).**
1. Commit de release : `CHANGELOG.md` « Non publié » → `## X.Y.Z — <date>`.
2. Builds de production, sur le Mac : `make desktop-tauri-mac TAURI_VERSION=X.Y.Z
   TAURI_IDENTITY=production TAURI_POPUP=…/OpenedbotPopup.app`, puis `make desktop-tauri-linux
   TAURI_VERSION=X.Y.Z TAURI_IDENTITY=production TAURI_LINUX_ARCH=x86_64` et de même pour
   `aarch64` (Docker, clé de mise à jour montée en lecture seule).
3. `make desktop-tauri-release TAURI_VERSION=X.Y.Z [TAURI_NOTES=notes.md]`.
4. R2 (jeton Cloudflare à droits R2, jamais en argument) : le contenu de `publish/vX.Y.Z/` sous
   `desktop/vX.Y.Z/`, `SHA256SUMS` en dernier ; relire depuis
   `https://releases.openedbot.app/desktop/vX.Y.Z/` (`release.ts verify --dir` sur une copie).
5. `publish/solo/beta/latest.json` → `desktop/solo/beta/latest.json`.
6. Tag `desktop/vX.Y.Z` poussé : `desktop-release.yml` vérifie et publie la release GitHub
   (`--latest`). Le site sert alors la nouvelle version par `releases/latest/download/…` ; ses
   liens Windows sont à retirer (dépôt `openedbot-site`), ses liens arm64 Linux à ajouter.
7. Promotion stable : `publish/solo/stable/latest.json` → `desktop/solo/stable/latest.json`.
8. Déploiement de la console web : c'est lui qui fait passer les apps 1.0.x à l'état décrit plus
   haut ; le faire après l'étape 6, pour que le téléchargement existe.

### 4.3.7 Encoche à la première connexion, rail et focus (D3b, 2026-11-06)

Branches `feat/d3b-notch-onboarding` (app) et `feat/notch-onboarding` (openedbot-notch, sur
`feat/update-badge`). Décisions de l'utilisateur : l'encoche se présente par une démonstration et
un choix à la première connexion, comme OpenBot ; elle n'existe qu'avec une session ; « Garder
l'encoche » vaut fenêtre et encoche ; l'écran de la caméra seulement ; un volet Réglages › Encoche
dans l'app Tauri sur Mac (rien dans le bundle web) ; un plantage en boucle ne retire plus le
choix. Ajouts demandés pendant l'étape : la mise à jour dans le rail d'icônes, le bleu des mises
à jour d'Apple partout, et aucun contour de focus dans l'app de bureau.

**Qui décide (coque, `notch.rs`).** La préférence `displayMode` reste la seule chose gardée ;
`None` veut dire « pas encore choisi ». Le reste vit le temps d'un lancement (`NotchSession`).

```
 session ouverte (connexion, ou session restaurée au lancement)
        |
        v
 choix déjà fait ? --- oui ---> popup_plan : Window -> arrêté, Popup/Both -> encoche des bots
        |
       non (et encoche disponible : macOS, bundle présent, `popup` actif dans config.json)
        |
        v
 onboarding : le popup joue `demo{cycles:0}` (bots fictifs, aucun réseau)
              la console ouvre la feuille « openedbot vit aussi dans l'encoche »
        |
        +-- « Garder l'encoche » ------------> displayMode = both, `endDemo`, bots de la session
        +-- « Pas maintenant » / Échap ------> displayMode = window, popup arrêté
        +-- fermer ou quitter sans répondre -> rien d'écrit : la question revient au lancement suivant
```

| Situation | Encoche | Feuille | Préférence écrite |
|---|---|---|---|
| Pas de session (page de connexion) | arrêtée | non | non |
| Première session, rien de choisi, Mac avec bundle | démonstration | oui | non |
| Idem, popup sans `demo` (ancien bundle, `ready` sans la capacité) | arrêtée | oui, avec un aperçu dessiné | non |
| Hors macOS, bundle absent, `popup: false` | arrêtée | non | non (effectif : fenêtre) |
| « Garder l'encoche » | bots de la session | fermée | `both` |
| « Pas maintenant », Échap | arrêtée | fermée | `window` |
| Mise à jour d'une version où le choix est fait | selon le choix | jamais | inchangée |
| Plantage en boucle (`Crashing`) | en pause jusqu'au lancement suivant, dialogue « Encoche arrêtée » | non | inchangée |
| Bundle absent ou protocole incompatible | arrêtée | non | `window` (comme avant) |
| Fermée par l'utilisateur (menu du popup) | arrêtée | — | inchangée (comme avant) |
| Pendant la démonstration, popup en échec | arrêtée, la feuille reste | oui, aperçu | non |

**Protocole.** Dans la v1, additions compatibles : `ready.features` (`["demo"]`), le bundle les
déclare aussi (`OpenedbotHostedFeatures` dans l'`Info.plist`) ; hôte → popup `demo{cycles}` et
`endDemo`, popup → hôte `demoEnded`. La démonstration n'est envoyée qu'à un popup qui l'annonce ;
la coque n'envoie une ligne qu'au run qui a dit `ready` (un run remplacé ne parle plus pour le
nouveau, revue Codex).

**Démonstration (openedbot-notch, `DemoFeed.swift`).** Deux bots fictifs, Recherche et Rédaction ;
un cycle d'environ 12 s : île compacte « en cours », Rédaction demande un accord et l'île se déplie
sur « Autoriser » / « Refuser » (réponse locale, accord automatique au bout de 4 s), puis
« terminé ». Elle boucle et s'arrête à la fin du cycle pendant lequel l'utilisateur l'a touchée
(survol, clic, réponse) ; un refus garde le billet en brouillon. « Revoir la démonstration » joue
deux cycles puis rend l'encoche au choix gardé. Pendant la démonstration : île centrée sur la
caméra quel que soit le bord choisi (sans l'écrire), aucune notification ni bannière, la boîte de
la session mise de côté puis rendue au premier roster du flux qui reprend, ses demandes d'accord
recalées sur leur identité openedbot, la bannière d'accord interrompue remise en tête si la demande
attend toujours. Les messages déjà vus sont gardés avec la boîte : le flux qui reprend relit les fils
que la session avait chargés (jusqu'à ce que chacun ait été lu, même après un échec ou une
démonstration rejouée), et une réponse arrivée pendant la démonstration s'annonce une fois, l'ancien
jamais. Le flux de la session arrêté n'écrit plus le modèle (génération : relectures en vol, flux
d'événements, réponses d'accord, envois, réactions, catalogue et choix du modèle). L'île se place sur l'écran qui a la caméra
(sinon l'écran principal) et se replace au réveil (`didWake`, `screensDidWake`) et quand les écrans
changent.

**Console.** `components/desktop-notch/` (feuille, aperçu) et `screens/settings/general/notch.tsx`
(Réglages › Encoche : afficher dans l'encoche, masquer la fenêtre, revoir la démonstration, ligne
« L'encoche n'est pas disponible dans cette version. » sinon), chargés à part et absents du build
web ; pont `notch_state`, `set_notch_mode`, `play_notch_demo`, événement `notch-state-changed`.
Note de bas de feuille : « Réglages › Encoche » (le volet est dans le groupe « Moi », il n'y a pas
de groupe « Général »). Pendant la pause d'un plantage en boucle, l'interrupteur montre l'effectif
(fenêtre) ; le choix gardé revient au lancement suivant. Menu du Dock : « Fenêtre », « Encoche
seule », « Fenêtre et encoche ».

**Mise à jour dans le rail.** La disposition « c » (rail d'icônes) n'avait aucune indication de
mise à jour. Un carré de 36 px se pose juste au-dessus de Réglages (`update-rail-button.tsx`, même
état que la pastille de 4.3.4) : anneau pendant le téléchargement, icône de téléchargement une
fois prête (infobulle « Mettre à jour — openedbot X.Y.Z est prête », clic → « Mise à jour prête »),
rien au repos ni en erreur, aucune place réservée, entrée animée par le script (rien dans le CSS
web). La pastille du pied de liste s'efface là où le rail s'affiche ; les autres dispositions la
gardent.

**Bleu des mises à jour.** Le bleu « info » sombre (#8ec5ff sur #16245699) se lisait mal. Un
jeton dédié, `--update-accent` : systemBlue d'Apple, #007AFF en clair, #0A84FF en sombre, en
aplat sous du blanc (`--update-accent-contrast`) ; survol #0069D9 en clair, #2A8FFF en sombre.
Blanc sur #007AFF 4,02:1, sur #0A84FF 3,65:1, sur les survols 5,22:1 et 3,25:1 : au-dessus du
3:1 d'une icône (WCAG 1.4.11), pas du 4,5:1 d'un petit texte, d'où le libellé en gras de la
pastille. Le point de l'encoche prend `NSColor.systemBlue`. `--state-info-*` ne change pas.

**Focus.** L'app de bureau n'affiche plus aucun anneau ni contour de focus, clavier compris : le
build desktop n'installe pas `trackKeyboardFocus` (`<html>` ne porte jamais `data-keyboard-focus`,
dont dépendent les variantes `focus-visible:` / `focus-within:` et les règles de focus) et pose une
feuille (`lib/platform/desktop-focus.ts`) pour le contour natif et la bordure du composer. Le focus
lui-même ne change pas. Le build web garde le suivi et ne contient pas la feuille (vérifié sur les
deux builds). Le bouton du rail n'a donc pas d'anneau dans l'app, contrairement à la demande
initiale.

**Éprouvé à l'écran** sur des builds de production signés, notarisés et agrafés (1.1.4-test à
1.1.12-test) : pas d'encoche avant la connexion ; démonstration et feuille à la première connexion
(clair et sombre), les phases du cycle, l'arrêt après un survol ; « Garder l'encoche » → `both`,
encoche des bots ; « Pas maintenant » → `window`, popup arrêté ; quitter sans répondre → la
question revient ; Réglages › Encoche (clair et sombre), revoir la démonstration ; menu du Dock ;
boucle de plantage (5 redémarrages puis pause, choix gardé, relancée au lancement suivant) ; mises
à jour 1.1.4 → 1.1.5 → 1.1.6 → 1.1.8 → 1.1.10 par le flux local, choix gardé et aucune feuille ;
bouton du rail, infobulle et dialogue (clair et sombre), pastille et point de l'encoche en
systemBlue ; aucun contour après un clic, après Tab, dans un champ, dans le composer et dans
« Mise à jour prête » (clair et sombre). **Par les tests seulement** : Échap sur la feuille (le
harnais de test pose un event tap clavier qui consomme Échap avant toute app : une instrumentation
du 1.1.12-test montre Tab reçu par la page, Échap jamais) ; le réveil (pas de mise en veille du Mac
de l'utilisateur ; `PlacementTriggers` testé) ; l'absence de notification pendant la démonstration
(test du `NoticeCenter`).

**Écarts connus.** À l'ouverture au lancement, Tab sort de la feuille vers la page derrière (le
piège de focus du `Dialog` ne se déclenche pas quand la fenêtre n'était pas active au montage) ;
la barre des menus (élément d'état du popup) montre aussi les bots fictifs pendant la
démonstration.

### 4.4 Console : origine, plateforme, performance

**Découpler la console de son origine** (bloquant pour l'embarquement, O) :

- toute origine passe par l'adaptateur de plateforme : origine de l'API (runtime en desktop,
  section 4.3), URL publique de la console pour les liens d'invitation, les webhooks et
  `openInBrowser` ;
- un garde interdit `location.origin` et `window.location.origin` hors de l'adaptateur dans la
  console du cœur. Les plugins pro (par exemple
  `openedbot-pro/packages/pro-agency/console/screens/agency-invitation.tsx:62`) ne tournent que sur
  le web (section 4.2) et ne sont pas concernés ;
- un repli `index.html` pour les chemins profonds et les `location.replace` (6 sites) ;
- CSP : autoriser l'IPC de Tauri, sortir le script Umami du desktop ;
- zones de déplacement : `-webkit-app-region` vers l'attribut de Tauri.

**API, en face** :

- une **liste d'origines natives** distincte de `CORS_ALLOWED_ORIGINS`, qui alimente aujourd'hui
  aussi les origines de retour jugées fiables (`api-config.ts:397-406`). Les origines natives
  servent au CORS seulement, jamais de retour OAuth ;
- `tauri://localhost` (macOS, Linux) et `http://tauri.localhost` (Windows) sont les valeurs par
  défaut de Wry ; elles sont confirmées sur les binaires réels en D2 ;
- `"null"` n'est **jamais** autorisé. `new URL("tauri://localhost").origin` vaut `"null"` en
  JavaScript, ce qui explique `auth.ts:686` ; l'en-tête `Origin` réellement émis par WKWebView est
  mesuré au prototype ;
- `Access-Control-Expose-Headers: X-Request-Id`, `Access-Control-Max-Age`.

**Performance** (bénéficie aussi au web et à l'Electron actuel) :

1. Analyse du bundle d'abord (variantes solo desktop et web de production), puis chargement différé de
   `ConversationScreen`, `SupportPanel` et KaTeX, et imports ciblés de `ui-kit` au lieu du barrel.
   La réduction à une seule librairie d'icônes vient après, si l'analyse montre un gain (Q4).
2. Streaming : l'état du message en cours vit dans un store dédié auquel seul ce message
   s'abonne ; le découpage en blocs devient incrémental ; la timeline cesse de se re-rendre à
   chaque frame.
3. Longs fils : virtualisation de la timeline (faite en D1d, section 3.4).
4. L'interrogation d'un fil ouvert toutes les 5 s (`use-thread-stream.ts:237-249`) a une raison
   documentée (revue automatique) : elle n'est retirée qu'une fois S6 livrée et la couverture
   par événements prouvée. S6 est livrée ; la preuve de couverture (tout ce que relit cette
   interrogation passe-t-il par un événement ?) reste à faire, l'interrogation est gardée.
5. Garde en CI : budget du chunk d'entrée (script de contrat, comme le cliquet des 600 lignes).

### 4.5 Serveur : création des tours et états des runs

**Écritures de création centralisées.** `insert into runs` apparaît à **16 endroits** en
production (API 5, `execution/src/sql/runs.ts` 2, `routines.ts` 2, `runner/rooms.ts` 2,
`handoff.ts` 2, `workflows.ts` 2, `persist.ts` 1). Admission par l'utilisateur, routine, enfant
de workflow et handoff n'ont pas les mêmes invariants : une commande unique deviendrait un
nouveau monolithe. Cible : **plusieurs commandes explicites** dans `modules/execution`
(`admitUserTurn`, `fireRoutine`, `startWorkflowStep`, `handoff`…) qui partagent des primitives
transactionnelles privées ; un garde interdit toute écriture physique dans `runs` et `workflows`
hors de ces primitives. Le trigger de revue des messages privés
(`db/migrations/0091_run_admission_envelope.sql:43-60`) est conservé, ou remplacé dans la même
migration. L'inventaire S2a ([0002](0002-invariants-des-runs.md)) confirme les 16 écritures (plus
7 `insert into workflows` et celui du trigger), détaille leurs invariants et propose les commandes
de S2b ; il relève qu'un brouillon de persona (ou un run entrant de handoff hérité, ou un DM d'agence
dont l'initiateur a été effacé) en `unknown` n'a aucun chemin de revue (défaut D1, prouvé par
`tests/integration/orphan-unknown-runs.ts`). **Fait en S2b** ([0002](0002-invariants-des-runs.md),
section 9.1) : dix commandes (`admitUserTurnTx`, `branchTurnTx`, `admitWebhookDeliveryTx`,
`openWorkflowRetryTx`, `fireRoutineTx`, `queuePersonaDraftRunTx`, `greetNewBotTx`,
`startWorkflowStepTx`, `chainLegacyRoomTurnTx`, `openHandoffTx`) sur trois primitives privées
(`sql/run-writes.ts`) ; `tests/scripts/run-writes-contract.ts` interdit toute autre création et met
les 102 autres écritures de `runs` / `workflows` sous un cliquet daté pour S2d ; le trigger 0091 est
remplacé par 0175, qui ouvre la revue de tout run sans workflow passé en `unknown` (D1 corrigé).

**Transitions explicites.** Les changements de `runs.status`, `external_state` et
`remote_stop_state` (51 instructions `update runs`, dont 38 posent `status`, inventaire 0002
section 7) passent par une fonction de transition qui refuse une transition illégale et garde le
fencing par bail (`lease_owner`, `lease_generation`). **Fait en S2d**
([0002](0002-invariants-des-runs.md), section 9.3) : `modules/execution/src/sql/run-transitions.ts`
(`transitionRuns`) est le seul écrivain des trois colonnes. Il refuse avant d'écrire une transition
absente des tables de `domain/run-transitions.ts` (statut, état externe, arrêt distant) et garde
dans son `where` l'état d'origine et le bail du worker (propriétaire, génération **et échéance** :
un bail expiré n'écrit plus, même avant d'être repris) ; il rend les lignes qui ont bougé. Les autres
colonnes passent par des écritures nommées (`sql/run-columns.ts`). Les 66 `update runs` du cliquet
S2b en sortent tous ; la garde `run-writes-contract.ts` est stricte pour `runs`, et ne compte plus
que les 36 `update workflows` (cliquet daté). D4, D6 et D9 corrigés ; test
`tests/integration/run-transitions.ts` (deux workers, transitions illégales, D4, D6, D9).

**Événements.** Deux choses distinctes à préserver : la `sequence` par run (calcul
`max(sequence)+1` présent à 14 endroits sur `run_events`) et l'ordre de commit du curseur global.
L'inventaire (0002 section 5) les classe : 5 calculs dans une instruction qui suit la prise du
verrou du curseur de l'organisation, sérialisés par ce verrou ; 3 calculs dans **la même
instruction** que la prise du verrou (CTE de `queue.ts:88-108`, `runtime-direct.ts:87-106`,
`runtime-links.ts:149-168`), qui lisent un instantané antérieur à l'attente et perdent leur
événement en silence (`on conflict do nothing`, observé par une sonde) ; 6 calculs du worker
**hors transaction** (par exemple `provider-recovery.ts:346-350`), suivis de `persistEvents`, qui
verrouille le run (`persist.ts:208`) puis le curseur (`persist.ts:219`) sans recalculer et jette
une collision. Être « dans la transaction » ne suffit pas à sérialiser un `max+1`. Cible : une
seule primitive d'allocation qui prend **les deux verrous dans cet ordre**, puis calcule dans une
instruction séparée, dans la transaction qui insère, et un test de producteurs concurrents sur un
même run (section 5). **Fait en S2c** ([0002](0002-invariants-des-runs.md), section 9.2) :
`modules/execution/src/sql/run-events.ts` est le seul écrivain de `run_events` (`appendRunEventsTx`
alloue, `appendNumberedRunEventsTx` contrôle les séquences du flux du worker, déjà publiées avant
le commit, et refuse une collision par `RUN_EVENT_SEQUENCE_CONFLICT`) ; les 14 calculs et les
séquences en dur y passent ; garde `tests/scripts/run-events-contract.ts` ; test concurrent
`tests/integration/run-event-sequences.ts`, qui reproduit D2 et D3 sur le code d'avant.

**Découper `executeRun`** (fermeture de 1 250 lignes, `runner.ts:102-1357`) en étapes nommées :
préflight, création, streaming, approbations, repli de fournisseur, réconciliation. **Fait en S2e**
([0002](0002-invariants-des-runs.md), section 9.4) : `runner.ts` (1 331 lignes) devient une suite
d'appels de 91 lignes ; chaque étape est un module de `application/runner/` (`admission.ts`,
`preflight.ts`, `creation.ts`, `event-stream.ts` et `frame-events.ts`, `stream-fallback.ts`,
`approval-forwarding.ts`, `supervision.ts`, `settlement.ts`) qui reçoit ses entrées en arguments ;
le seul état partagé avec les minuteries est `RunState` (`run-state.ts`), passé explicitement.
Comportement identique (tests existants, golden inchangé) ; `runner.ts` sort du cliquet de taille.

### 4.6 Serveur : propriété de l'exécution, frontières, contrats, temps réel

- **Propriété de l'exécution.** `apps/api/src` crée 12 `HermesClient` (13 avec `scripts/seed.ts`),
  mais tous ne lancent pas un tour : certains sont des lectures (`runtime-provider-usage-routes.ts:109`,
  `runtime-model-context-routes.ts:93`). Faire passer ces appels par un port appelé depuis l'API
  laisserait l'effet dans l'API. Cible : séparer
  - les **lectures et l'administration** du runtime, qui restent synchrones via `modules/runtimes` ;
  - les **mutations d'exécution** (compaction, nouvelle version d'un message…), qui deviennent des
    commandes durables exécutées par le worker.

  **État S3 (livré).** Inventaire des 13 constructions (12 dans `apps/api/src`, plus
  `apps/api/scripts/seed.ts`) : douze sont des lectures ou de l'administration de l'hôte (sondes,
  modèles, usage, fenêtre de contexte, inventaire, MCP, OAuth, profils, outils `openedbot_routines`
  et `openedbot_bot_settings` posés sur l'hôte, import de profils, seed). La nouvelle version d'un
  message était **déjà** une commande durable : la route crée un run de branche
  (`branchTurnTx`) que le worker exécute, et son seul appel Hermes est une lecture du contrat des
  toolsets. Une seule mutation d'exécution tournait dans l'API : la compaction d'un salon à la
  demande (`thread-compact-routes.ts`), qui ouvrait une session et des runs de résumé pendant la
  requête.
  - **Lectures et administration** : un seul client, `runtimeAdminClient`
    (`modules/runtimes/src/application/runtime-admin-client.ts`). Son type n'a aucun verbe
    d'exécution (`ensureSession`, `createRun`, `getRunStatus`, `events`, `steerRun`, `stopRun`,
    `respondApproval`) et son proxy les refuse à l'appel, même par un transtypage. Les onze
    routes et le seed l'utilisent ; comportement inchangé.
  - **Compaction** : commande durable `thread.compact` dans `execution_commands` (0176, propriété
    `execution`). La route garde comme avant (droits, abonnement, salon, run actif, seuil,
    runtime), enregistre la commande, puis attend son règlement en relisant la ligne : la réponse
    HTTP est la même qu'avant, la console n'a pas changé. Le worker (passe `execution-commands`,
    250 ms, deux commandes au plus par processus, non bloquantes) la réclame sous bail clôturé
    (propriétaire, génération, échéance de 60 s, battement de 15 s), relit le salon (un run a pu
    commencer), exécute `compactThreadNow` sur le profil et le modèle du dernier membre qui a
    parlé, avec la clé Hermes `compact:<commande>:<séquence>`, puis règle la commande. Défaillances :
    une commande active par salon et par type (index unique, `COMPACTION_IN_PROGRESS` sur toutes
    les répliques) ; rejeu par `Idempotency-Key` avant les gardes ; API perdue entre
    l'enregistrement et la réclamation : la commande attend, un worker l'exécute, un rejeu rend
    son résultat ; jamais réclamée avant l'échéance de la requête : retirée
    (`COMPACTION_NOT_STARTED`), et toute commande jamais démarrée en file depuis 5 min est échouée
    (`COMMAND_EXPIRED`), une commande rendue par un worker qui s'arrête restant en file ; deux
    requêtes simultanées sous une même clé n'enregistrent qu'une commande ; worker mort : bail expiré, reprise (tentative 2, génération 2), ses
    écritures refusées, échec nommé après 3 tentatives (`COMMAND_ATTEMPTS_EXHAUSTED`), ou succès
    si la dernière avait déjà écrit son résumé ; un run de résumé laissé sur l'hôte vaut une
    reprise de plus, pour l'arrêter avant de régler la commande ; une reprise qui ne peut
    pas réutiliser le run de la tentative précédente (clé déplacée) l'arrête, comme une reprise
    refusée par le salon (un tour a démarré entre-temps) ; arrêt
    propre : commande rendue sans compter la tentative ; annulation
    (`DELETE /api/threads/:threadId/compact`) : immédiate pour une commande jamais démarrée ; en
    cours, par le battement, et l'écriture du résumé comme le règlement en succès la refusent même
    entre deux battements ; le run de résumé sur l'hôte, enregistré sur la commande
    (`hermes_run`), est arrêté avant de libérer le salon, y compris par le worker suivant pour une
    commande rendue à l'arrêt (un bail perdu ou un arrêt du worker le laissent tourner : la
    tentative suivante le reprend par sa clé).
    Le résumé de chaque passe s'écrit dans la même transaction que la progression de la commande
    (`progress`), sous son bail : un worker dont le bail a expiré n'écrit rien, et un worker mort
    entre le résumé et le règlement laisse une progression que la tentative suivante règle au lieu
    de refuser un salon passé sous le seuil. Le filigrane de `thread_compactions` ne recule plus :
    un résumé tardif (compaction automatique d'un run) ne remplace pas un résumé plus avancé. Test
    `tests/integration/execution-commands.ts`.
    Limite connue : un worker qui meurt entre l'acceptation du run de résumé par l'hôte et
    l'écriture de son `hermes_run` (une requête SQL) laisse ce run sans poignée ; une reprise le
    retrouve par sa clé, mais une annulation demandée entre-temps règle la commande sans
    l'arrêter. Le run s'arrête seul à son échéance et le filigrane monotone protège l'historique ;
    le combler demande de lire un run par sa clé d'idempotence sur l'hôte, que `HermesClient`
    n'expose pas.
  - **Garde** : `tests/scripts/runtime-client-contract.ts` refuse `new HermesClient` dans l'API
    (routes et scripts), l'appel d'un verbe d'exécution, l'import du client du worker et des
    points d'entrée de l'exécution ; dans les modules, `new HermesClient` n'est permis que dans
    cinq fichiers classés ; chaque méthode de `HermesClient` doit être classée exécution ou
    lecture/administration. Sur `develop` avant S3, elle relève les 13 constructions et l'import
    de `compactThreadNow`.
  - Restaient hors de l'API mais construits dans des modules qu'elle appelle, classés
    lecture/administration : `roster/application/bot-host.ts` (profils et sessions d'un bot) et
    `runtime-link/application/gateway.ts` (sonde d'enrôlement). Depuis S4 ils construisent
    `runtimeAdminClient`, et la garde ne classe plus que les deux fabriques et le client.
- **Frontières des modules.** Les exports de packages ne publient plus `./sql/*` ; un module
  n'importe un autre module que par sa couche `application` publique ; règles dependency-cruiser ;
  cycles de packages cassés (roster ↔ conversation, roster ↔ portability, runtimes ↔ runtime-link,
  identity → execution → roster → identity). **Avant** de restreindre les exports, les
  consommateurs pro des exports SQL (par exemple
  `openedbot-pro/packages/pro-agency/src/invitations.ts:17`, pro-staff, pro-billing) migrent vers
  des façades publiques, vérifiées par `make test-dual` et `make solo-check` (`Makefile:451-484`).
  Les ~670 lectures de tables étrangères sont gelées par un cliquet puis réduites.

  **État S4 (livré).** Les façades d'abord, la restriction ensuite.
  - **Façades pour pro.** Pro importait sept fichiers SQL du cœur (`identity/sql/sessions`,
    `accounts`, `staff-access`, `blob-deletions`, `deletions`, `product-features` et
    `roster/sql/permission-grants`, dont `pro-agency/src/invitations.ts:17`). Chacun a une façade
    dans la couche `application` de son module, qui réexporte ce qu'elle ouvre ; pro y est passé
    sur sa branche `refactor/s4-core-facades`, à fusionner avec celle du cœur.
  - **Exports restreints.** Les paquets ne publient plus `./sql/*` (`support` publie
    `./application/*`). Les fichiers du cœur qui importaient le SQL d'un autre paquet passent par
    une façade au nom du fichier SQL (`conversation/application/threads`,
    `execution/application/run-events`, `runtimes/application/runtime-rows`…) ou par une
    réexportation ajoutée au cas d'usage qui existait déjà. Règles dependency-cruiser
    `sql-prive-au-module` (le `src/sql` d'un module ne s'importe que de ce module) et
    `porte-permissions-par-le-port`, étendue aux façades du roster et de `runtimes`.
  - **Cycles cassés.** dependency-cruiser ne voyait aucun cycle de fichiers ; le graphe des
    paquets en avait deux : `runtime-link ↔ runtimes`, et `identity → execution/portability →
    roster → identity` avec `roster ↔ conversation`, `roster ↔ portability` et
    `roster ↔ execution`. Le graphe est désormais en couches ; un module n'importe que ceux, plus
    bas, que déclare son `package.json` :

    ```
     portability
          │
          v
     execution
          │
          v
       roster
          │
          v
     conversation       identity       runtimes  <───  runtime-link
                            │                              │
                            v                              │
                      notifications  <─────────────────────┘
    ```

    `dm-handoff`, `global-search` et `thread-find`, qui lisaient le balisage des mentions du
    roster, passent de `conversation/domain` à `roster/domain`. Le roster demande ses runs
    (accueil, brouillon de persona, passes de maintenance) par le port `BotRuns`, implémenté par
    `execution/application/bot-runs` et passé par l'API. `permission-rule-input`, lu par le seul
    plug-in `permissions`, passe à `execution/domain`. Les aides de profil hôte (verrou et
    réservations d'import, modèle, création, erreurs) passent de `portability` au roster, avec
    ses deux écritures de `team_imports` (writer déclaré). La suppression de compte, le retrait
    d'un membre et la purge d'un tenant reçoivent en argument obligatoire ce qu'ils demandent à
    l'exécution et aux imports (`TenantPurgeProfileJobs`, `portability/application/tenant-purge`).
    Le registre des liens, les types du localisateur et le résultat de sonde passent à
    `runtimes/application/runtime-link-port`, réexportés par `runtime-link`. Gardes :
    `workspace-deps-contract.ts` refuse un cycle des dépendances `@openedbot` déclarées, la règle
    `module-par-ses-dependances` tient chaque module aux modules de son `package.json`.
  - **Propriété étendue à `apps/*`.** La seconde passe de `db-ownership-contract.sh` lit aussi
    `apps/*/src` ; chaque application est un contexte (`apps/api`, `apps/worker`). `apps/api`
    possède `api_errors` (writer `apps/worker`, qui la purge) et les tables des webhooks sortants ;
    les 36 tables de modules que l'API ou le worker écrivent en SQL en ligne les nomment en
    `writers`, écritures inter-contextes déclarées. 557 écritures vérifiées.
  - **Cliquet sur les lectures étrangères.** `tests/scripts/foreign-reads-contract.ts` compte par
    fichier et par table les lectures (`from`, `join`) d'une table d'un autre contexte dans le SQL
    livré des modules et des applications : 553 sur `develop` (99 fichiers, dont 299 dans
    `apps/api` ; l'estimation de ~670 comptait aussi des écritures). Elles sont gelées dans
    `foreign-reads-debt.json` (jusqu'au 2027-06-30) ; un compte ne fait que baisser. Réduites à 543
    sans changer de requête : une copie de `readOperatorProfile` dans `misc-routes.ts`, la lecture
    du pipeline d'une organisation par le roster (celle d'identity), et les 8 lectures des tables
    de webhooks par leur nouveau propriétaire.
  - Aucune migration, aucun changement de comportement. Aucune erreur nouvelle : les routes
    touchées ne changent que leur câblage, la règle des erreurs de domaine n'a rien à convertir.
- **Erreurs et contrats.** Erreurs de domaine dans les modules (code stable, sans statut HTTP ni
  texte français) ; `apps/api` fait la correspondance HTTP ; les clients traduisent par code.
  Schémas zod dans `contracts/api`, validés par un middleware. Ces deux règles s'appliquent **dès
  la première étape** à chaque route touchée, au lieu d'attendre une migration générale des 314
  `new HttpError` ; un cliquet suit le reste.
- **Temps réel multi-instances.** La diffusion vit dans un seul processus d'API (EventHub en
  mémoire, poller par organisation, alerte HTTP du worker vers une seule URL, repli à 5 s). Bun
  1.4 fournit `listen` et le worker l'utilise déjà pour la file, avec un repli par sondage
  (`run-queue-notifications.ts`) ; le commentaire « LISTEN non supporté » vise Bun 1.3. Cible : une
  connexion LISTEN par processus (chaque réplique d'API, chaque worker), avec réabonnement. Le
  trigger `pg_notify('openedbot_events')` (`0005_runs_workflows.sql:236-243`) est **gardé** et
  reçoit enfin un écouteur. Une notification ne fait que réveiller une lecture depuis le curseur
  durable : le journal et le rattrapage restent la source de vérité.

  **État S6 (livré).** Chaque processus d'API tient **une** connexion LISTEN dédiée sur
  `openedbot_events` (`apps/api/src/infrastructure/event-notifications.ts`). Une notification
  `<organisation>:<curseur>` réveille la pompe ordonnée de cette organisation, si un flux SSE de
  la réplique la suit ; chaque accusé de LISTEN (premier abonnement, puis chaque réabonnement que
  Bun refait seul après une coupure) réveille toutes les pompes, qui relisent depuis leur curseur.
  Les pompes vivent par hub (`routes/events/replay-pollers.ts`) et non plus dans un registre
  global au module, qui faisait publier deux instances d'un même processus dans le seul hub de la
  première. Le trigger 0005 n'a pas bougé : il est par ligne sur `run_events`, donc il notifie
  toutes les écritures de la primitive S2c (worker, API, plug-ins), au commit seulement ; les
  événements écrits par l'API elle-même (annulation, version d'un message, relance), qui
  n'avaient aucun réveil et attendaient le sondage de 5 s, arrivent maintenant en direct.
  `run_events` est la seule source du curseur du flux SSE ; `support_events` (guichet pro) garde
  son propre sondage, hors S6.

  Bun ne signale pas la perte d'une connexion LISTEN avant le réabonnement : un ping
  (`pg_notify` par le pool ordinaire, toutes les 5 s) prouve le lien de bout en bout et mesure son
  retard. Sans réponse, le lien est dit non confirmé. Le worker n'écoute pas ce canal (il ne lit
  pas le flux) ; il garde sa connexion LISTEN de file.

  L'alerte HTTP post-commit du worker est **gardée en repli** : l'API ne la suit que tant que
  son lien n'est pas confirmé (indisponible au démarrage, coupé, ping sans réponse), ce qui rend
  dans ce cas le comportement d'avant S6 au lieu de tout laisser au sondage. Le `POST` lui-même
  reste nécessaire pour les trames pré-commit (deltas sans curseur, qu'aucune table ne porte) ;
  le réveil post-commit y voyage déjà sans requête de plus. Retirer les `POST` qui ne portent
  qu'un réveil touche `modules/execution` (persist, cancel, failure, queue) : étape suivante.
  Le sondage de repli de l'API (`API_EVENTS_FALLBACK_POLL_MS`, 5 s) reste le filet.

  Observabilité, par processus : `GET /internal/metrics` porte `eventLink` (état, `connected`,
  abonnements, réabonnements, échecs, pings sans réponse, notifications, retard `lagMs` et
  `maxLagMs`) ; en Prometheus : `openedbot_api_events_listen_connected`,
  `openedbot_api_events_listen_{resubscriptions,failures,stalls,notifications}_total`,
  `openedbot_api_events_listen_lag_ms`. Journaux : `api.events_listener_ready` (`resubscribed`),
  `api.events_listener_failed` (essai, délai, `fallback: "poll"`), `api.events_listener_stalled`,
  `api.events_listener_recovered`, `api.events_listener_unsupported`. Aucune variable nouvelle.

### 4.7 Sécurité, protocole, observabilité

- **Changement de clé de l'appareil** (confirmé, `gateway.ts:417-467`). Sous le jeton de lien
  *courant*, un hôte peut proposer une nouvelle clé et prouver qu'il la possède ; l'ancienne clé
  n'est jamais exigée. Un voleur du jeton courant peut donc imposer sa propre clé. Cible
  (décidé le 2026-11-06, Q6) : refuser tout de suite un changement de clé implicite quand la
  clé proposée diffère de la clé enregistrée (les reconnexions avec la même clé ne changent pas) ;
  une machine qui a perdu sa clé repasse par l'inscription ; plus tard, une rotation signée par
  l'ancienne clé, négociée comme fonctionnalité du protocole. Avant de couper, compter les
  événements `rotated` / `device_key` du journal en production pour mesurer les hôtes touchés.
- **Secrets internes séparés.** `WORKER_INTERNAL_TOKEN` sert de bearer pour trois flux
  (publication d'événements, relais, signal d'inventaire) **et** de clé HMAC des clés de run.
  Cible : un secret par usage, la clé HMAC dérivée (HKDF) d'un secret maître distinct. La valeur
  de dev est refusée en production par l'API, le gateway (`api-config.ts:558`) et, depuis, le
  worker (`apps/worker/src/config.ts:344`).
  **Plan (S1b, 2026-11-07).** Inventaire des six usages de la valeur unique, présente dans les
  trois processus (API, worker, link-gateway) :

  | Usage | Émetteur | Vérificateur | Code |
  |---|---|---|---|
  | (a) publication d'événements | worker | API | `runner/events.ts`, `persist.ts` → `event-routes.ts:546` |
  | (b) relais vers un hôte (proxy, dial, contrôle, sonde) | worker | route interne de l'API ou du link-gateway, qui transmet à l'instance qui tient le lien | `runtime-client.ts:92` → `internal-relay.ts:73/140/192`, `apps/api/src/index.ts:274/292/352` |
  | (c) saut entre instances | API, link-gateway | autre instance | `instances.ts:171/220/359` |
  | (d) rotation du jeton de lien, inventaire des sessions | worker (tâches de maintenance) | instance qui tient le lien | `runtime-links.ts:191/279` |
  | (e) signal d'inventaire | link-gateway | API | `link-gateway/main.ts:39` → `runtime-inventory-warm.ts:107` |
  | (f) clés de run des outils MCP (routine, réglages du bot) | worker (signe) | API (lit) | `creation.ts:275-278` → `routine-tool-routes.ts:178`, `bot-settings-tool-routes.ts:128` |

  Une fuite depuis n'importe quel processus donne aujourd'hui les six : écrire dans le fil de
  n'importe quelle organisation, piloter n'importe quel hôte relié (y compris faire tourner son
  jeton de lien), fabriquer des clés de run. Le link-gateway, seul processus exposé aux hôtes,
  détient tout.

  *Secrets cibles* (un par rôle ; (b), (c) et (d) passent par les mêmes routes internes du relais,
  donc un seul secret) :

  | Variable | API | worker | link-gateway |
  |---|---|---|---|
  | `EVENTS_INTERNAL_TOKEN` (a) | vérifie | émet | — |
  | `RELAY_INTERNAL_TOKEN` (b, c, d) | vérifie, émet | émet | vérifie, émet |
  | `INVENTORY_INTERNAL_TOKEN` (e) | vérifie | — | émet |
  | `RUN_KEY_SECRET` (f) | vérifie | signe | — |

  La dérivation des clés de run ne change pas : `HMAC(HMAC(secret, libellé), runId)` est déjà une
  sous-clé par libellé (`routine-run-key.ts:20-22`) ; seul le secret maître change, et il n'est
  plus un bearer. Une clé de run n'expire pas (`runId.signature`) : elle vaut tant que son run vit,
  et un run repris (identifiant Hermes conservé, `runner.ts:75`), remis en file à l'arrêt
  (`worker-shutdown.ts:30`) ou réactivé depuis `unknown` (`run-review.ts:14`) garde la clé signée à
  sa création. D'où `RUN_KEY_PREVIOUS_SECRET` et `RUN_KEY_PREVIOUS_CREATED_BEFORE` (API
  seulement, l'un n'existe pas sans l'autre) : l'ancien secret n'est accepté que pour lire la clé
  d'un run dont `created_at` précède cette borne (la fin de la convergence de P2, date fixée et
  écrite dans le journal de bascule), jamais comme bearer ni pour signer. Une clé ancienne forgée
  pour un run créé après la borne est refusée : à P3, la fuite de l'ancien secret ne donne plus
  que les runs anciens encore vivants, cohorte qui ne peut que décroître. Retrait en P4, sur
  preuve en base.
  `METRICS_INTERNAL_TOKEN` reste à part et doit différer de tous. En dev et en préprod l'API tient
  elle-même les WebSockets (`embedded`) ; en production le link-gateway les tient et l'API relaie
  vers lui : les deux exigent `RELAY_INTERNAL_TOKEN`.

  *Configuration* (un module unique `platform/config` lu par l'API, le link-gateway et le worker,
  avec le rôle du processus) :
  - valeur d'un rôle = la variable du rôle, sinon `WORKER_INTERNAL_TOKEN` (repli, comportement
    d'aujourd'hui), sinon, hors production, une valeur de dev propre au rôle ;
  - un processus n'exige que les rôles qu'il utilise (tableau ci-dessus) ; le link-gateway n'a ni
    `EVENTS_INTERNAL_TOKEN` ni `RUN_KEY_SECRET`, et le code qui les utilise ne s'y compile pas
    (valeur absente du type, pas une chaîne vide) ;
  - en production : valeurs de dev refusées, valeurs explicites distinctes entre elles, de
    `WORKER_INTERNAL_TOKEN` et de `METRICS_INTERNAL_TOKEN` ; un avertissement au démarrage pour
    chaque rôle encore servi par le repli (auto-hébergement non migré : il démarre comme avant) ;
  - vérification : la valeur du rôle, plus `WORKER_INTERNAL_TOKEN` tant qu'il est défini
    (transition), plus, pour les seules clés de run, `RUN_KEY_PREVIOUS_SECRET` dans la cohorte
    ci-dessus ; comparaison à temps constant, aucune autre valeur ;
  - émission : `INTERNAL_TOKENS_EMIT=legacy` envoie `WORKER_INTERNAL_TOKEN` (et signe les clés de
    run avec), `split` (défaut) envoie la valeur du rôle ; en production, si une variable de rôle
    explicite **et** `WORKER_INTERNAL_TOKEN` coexistent, `INTERNAL_TOKENS_EMIT` doit être posée
    explicitement (garde contre une bascule implicite pendant un déploiement progressif) ;
    `legacy` sans `WORKER_INTERNAL_TOKEN` est refusé.

  *Déploiement sans coupure* (mise à jour progressive : anciens et nouveaux conteneurs coexistent
  à chaque phase ; une seule release de code, puis des changements d'environnement) :

  | Phase | Environnement | Vérifient | Émettent, signent | Recouvrement |
  |---|---|---|---|---|
  | P1 | code N ; quatre secrets générés (`openssl rand -hex 32`), `EMIT=legacy`, ancien secret gardé | rôle + ancien | ancien | conteneurs N-1 n'émettent et ne vérifient que l'ancien : accepté partout |
  | P2 | `EMIT=split` | rôle + ancien | rôle | conteneurs P1 émettent l'ancien, encore accepté ; nouveaux émettent le rôle, que tous acceptent depuis P1 |
  | P3 | `WORKER_INTERNAL_TOKEN` et `EMIT` retirés ; `RUN_KEY_PREVIOUS_SECRET` = l'ancien et `RUN_KEY_PREVIOUS_CREATED_BEFORE` = borne de P2 (API) | rôle ; clés de run : rôle, ou précédent pour un run d'avant la borne | rôle | conteneurs P2 vérifient encore les deux et émettent déjà le rôle |
  | P4 | `RUN_KEY_PREVIOUS_*` retirés, sur preuve P4 ci-dessous | rôle | rôle | aucune clé ancienne vivante |
  | N+1 | code : `EMIT` et la vérification de l'ancien supprimés ; le repli d'auto-hébergement reste au moins une release annoncée de plus | rôle | rôle | aucun effet en production |

  La séparation n'est effective qu'à P3 : tant que l'ancien secret est accepté, sa fuite garde
  tous les pouvoirs. *Barrière entre phases* : on ne passe à la suivante qu'une fois les trois
  services convergés (rapport Shuttle « Release identity verified », `UpdateState=completed` sans
  retour arrière Swarm pour `api`, `worker`, `link-gateway`, une seule version de spécification par
  service parmi ses tâches en cours, et pour chaque tâche les **références** de secrets Swarm
  attachées (`Spec.ContainerSpec.Secrets` : noms versionnés par Shuttle, jamais les valeurs)
  identiques à celles du service ; enfin la ligne de démarrage de **chaque** tâche en cours, qui
  annonce son mode : rôles explicites, ancien accepté ou non, `EMIT`, cohorte de clés de run, sans
  valeur ni empreinte de secret). Un retour arrière Swarm ou une tâche ancienne relancée arrête la
  procédure.

  *Preuves en base* (exécutées sur la base de production, résultat consigné dans le journal de
  bascule ; « vivant » = tout statut non final, `unknown` et en file compris, la liste venant du
  code des statuts et non recopiée à la main) :
  - **P4** : `count(*)` des runs vivants avec `created_at < RUN_KEY_PREVIOUS_CREATED_BEFORE` = 0 ;
  - **retour vers des vérificateurs `legacy` seuls** (code N-1, ou ancien secret seul) : une clé
    est signée au démarrage de l'exécution (`creation.ts:275`), pas à la création du run ; tout
    run existant au moment d'une passe `split`, quelle qu'elle soit, a donc pu recevoir une clé
    `split`. Preuve par drain : après convergence de `EMIT=legacy`, `count(*)` des runs vivants
    avec `created_at <` l'heure de cette convergence = 0 ; les runs créés ensuite n'ont que des
    clés `legacy`. Sinon leurs appels d'outils MCP échoueraient (« run_key is not valid »)
    jusqu'à leur fin.
  - La preuve P4 reste juste pour la même raison : un run créé avant la borne mais démarré après
    la convergence de P2 porte une clé du rôle, vérifiée sans le secret précédent.
  Toute bascule en arrière invalide une preuve déjà faite : elle se refait après la nouvelle
  convergence.

  *Retour arrière* : P1 → image et environnement précédents (P1 n'a encore rien signé avec les
  nouveaux secrets) ; P2 → `EMIT=legacy` ; P3 → remettre `WORKER_INTERNAL_TOKEN` **avec**
  `INTERNAL_TOKENS_EMIT=split` (retour à P2 ; sans `EMIT`, la configuration refuse de démarrer) ;
  revenir au code N-1 après P2 exige d'abord `EMIT=legacy` convergé, puis la preuve « retour
  vers `legacy` » ci-dessus.

  *Production (Shuttle, dépôt pro)* : chaque nouveau secret est un élément `secrets.items`
  distinct, `expose: env`, livré aux seuls services du tableau, sa valeur dans le fichier hôte
  `/etc/openedbot/shuttle.b64.env`. Ils ne doivent **jamais** figurer dans `OPENEDBOT_ENV_B64` :
  `entrypoint.sh` source ce paquet après les variables injectées et les écraserait (et un
  `RUN_KEY_SECRET` y reviendrait dans le link-gateway). L'entrypoint décode donc le paquet dans
  un fichier privé et, **avant** de le sourcer, refuse de démarrer s'il contient une affectation,
  même vide ou identique, de `EVENTS_INTERNAL_TOKEN`, `RELAY_INTERNAL_TOKEN`,
  `INVENTORY_INTERNAL_TOKEN`, `RUN_KEY_SECRET`, `RUN_KEY_PREVIOUS_SECRET` ou
  `RUN_KEY_PREVIOUS_CREATED_BEFORE` (avec ou sans `export`) ; les variables injectées par Shuttle
  restent permises (tests dans pro). `WORKER_INTERNAL_TOKEN` reste dans le paquet jusqu'à
  P3. Le rôle Ansible `openedbot_alpha`, `infra/scripts/secrets.sh` et `infra/preprod/render-env.sh`
  génèrent et inventorient les quatre secrets ; la procédure de production est écrite dans
  `DEPLOY-NOTES.md`, Ansible ne touchant pas l'environnement Shuttle.

  *Consommateurs à migrer* : `tests/e2e/connector-live-k6.ts:41`,
  `tests/e2e/runtime-link-live-continuity.ts:23` et leurs guides (secret du relais) ; le schéma
  d'environnement (`env-schema/shared.ts:261`), les gabarits générés et `scripts/env.ts` ; les tests
  d'intégration qui posent l'ancien secret ; `apps/worker/README.md`. `CHANGELOG.md` décrit la
  migration de l'auto-hébergement (facultative, repli conservé) et les limites du retour arrière.

  *Observabilité* : un compteur par rôle et par issue (accepté rôle, accepté ancien, refusé), par
  instance, sur chaque vérificateur, y compris le relais du link-gateway avant `relayJournal`
  (`internal-relay.ts:73`, `:86`) et les sondes qui changent un refus en `owner_unavailable`
  (`instances.ts:231`) ; une ligne de journal par refus (rôle, route, instance, jamais le bearer) ;
  les clés de run comptées à part, puisqu'elles reviennent en erreur d'outil
  (`routine-tool-routes.ts:179`) : acceptées par le secret du rôle, acceptées par le secret
  précédent (cohorte), refusées. Critères : zéro refus à chaque phase ; à P3, zéro **bearer**
  ancien accepté (les clés de run de la cohorte restent acceptées jusqu'à P4) ; à P4, zéro clé
  acceptée par le secret précédent depuis la preuve.

  *Preuves* : tests de configuration par rôle (exigences, distinctions, valeurs de dev, règles
  `EMIT`, `RUN_KEY_PREVIOUS_SECRETS` refusé comme bearer) ; chaque route interne refuse les secrets
  des autres rôles et l'ancien une fois retiré ; émetteurs en `legacy` et en `split` ; une clé de
  run signée avec un secret non configuré est refusée. Un test d'intégration dédié avec API,
  worker et link-gateway réels (pas `run-trace-correlation`, dont la publication vise une adresse
  morte et dont les erreurs de publication sont absorbées, `runner/events.ts:56`) : publication
  d'événements reçue par l'API, appels MCP réels pour les deux libellés de clé de run, signal
  d'inventaire, relais, en modes `embedded` et séparé ; recouvrements P1/P2/P3 rejoués avec deux
  configurations simultanées ; reprise d'un run signé avant la bascule ; clé ancienne forgée pour
  un run créé après la borne refusée ; P4 (secret précédent retiré : clé ancienne refusée) ; retours
  arrière P2 → P1 et P3 → P2 sans refus.
  **État (S1b, 2026-11-07)** : fait. Production basculée de P1 à P4 le 2026-11-07, chaque
  barrière passée (`DEPLOY-NOTES.md` du dépôt pro, « Internal secrets »). **N+1 fait le même
  jour, à la demande** : le repli sur `WORKER_INTERNAL_TOKEN`, `INTERNAL_TOKENS_EMIT` et la
  vérification de l'ancien secret sont supprimés du code. Écart au plan, qui gardait le repli
  d'auto-hébergement une release annoncée de plus : aucune release publiée n'a porté ce repli
  (S1b et N+1 sortent ensemble), il n'aurait donc servi à personne. À la place, un processus qui
  trouve encore `WORKER_INTERNAL_TOKEN` ou `INTERNAL_TOKENS_EMIT` refuse de démarrer avec la marche
  à suivre, l'outillage local les retire des fichiers d'environnement (`DEPRECATED_ENV_NAMES`), et
  le CHANGELOG décrit la migration d'un hôte auto-hébergé en un redémarrage, les runs en cours
  gardés par `RUN_KEY_PREVIOUS_*`. Ce couple reste : c'est la rotation de `RUN_KEY_SECRET`. `platform/config/src/internal-secrets.ts`
  lit les secrets par processus (`readInternalSecrets("api" | "worker" | "link-gateway")`) ; ils
  ne sont plus dans `ApiConfig`. Le type des secrets d'un processus n'a de champ que pour ses
  rôles : la passerelle ne compile aucun usage d'`events` ni de `runKey`. Compteurs :
  `platform/observability/src/internal-auth.ts`, dans `/internal/metrics` de l'API. Preuves :
  `platform/config/tests/internal-secrets.test.ts` (règles, variables retirées refusées),
  `apps/api/tests/internal-secrets-routes.test.ts` (chaque route contre chaque secret),
  `apps/api/tests/run-key-rotation.test.ts` (rotation de `RUN_KEY_SECRET` : cohorte, worker
  encore sur l'ancien secret, secret précédent retiré), `tests/integration/routine-tool.ts` et
  `bot-settings-tool.ts` (cohorte des clés de run sur PostgreSQL réel),
  `tests/integration/run-trace-correlation.ts` (worker, passerelle et connecteur réels, secrets
  séparés par processus), et la garde de l'entrypoint dans pro. Les tests de recouvrement des
  phases P1 à P4 ont été retirés avec N+1 : ces phases n'existent plus dans le code.

- **Contrat du connecteur unique.** `contracts/connector` et `protocol/connector` sont des
  copies ; les noms de fonctionnalités sont une liste en Go et des constantes éparses dans 10
  fichiers TS. Cible : `protocol/connector` fait foi, `contracts/connector` le réexporte, un test
  compare la liste Go à la liste TS.
  **État (S7, 2026-11-06)** : `protocol/connector` (`@openedbot/protocol-connector`, workspace de
  la racine) fait foi ; `contracts/connector` n'en garde que des réexports (prouvé par
  `protocol-allowlist-sync.test.ts`), le script de synchronisation ne copie plus le codec, et
  dependency-cruiser interdit à `protocol/` d'importer le dépôt. Les 28 noms vivent dans
  `protocol/connector/src/relay-features.ts` (`RELAY_HOST_FEATURES` dans l'ordre de priorité de
  l'hôte, `RELAY_LINK_FEATURES`) ; `relay-features.test.ts` lit `frames.go` et compare les deux
  listes, ordre compris, et refuse un nom écrit en dur ailleurs dans le code livré (vérifié par
  mutation des deux côtés). Déploiement : l'image de production doit désormais copier
  `protocol/connector` (Dockerfiles et `.dockerignore` du dépôt pro, qui l'excluent) ;
  `bun install --frozen-lockfile` échoue tant que ce n'est pas fait.
- **Corrélation de bout en bout.** Aucun identifiant ne traverse worker → gateway → connecteur
  → Hermes. Cible : `traceparent` transmis par le relais et ajouté à la liste blanche des en-têtes
  du connecteur ; logger commun dans le worker (aujourd'hui `console.info`).
  **État (S7, 2026-11-06)** : le trace-id d'un run est son UUID sans tirets
  (`platform/observability/src/trace-context.ts`) : il naît à l'admission (`run.admission`),
  sans colonne. Le worker ouvre le contexte de trace autour de chaque prise de run
  (`runWithTrace`, un span par prise) ; le mixin du logger colle `traceId`/`spanId` à chaque
  ligne écrite dedans, et le dialer du relais pose un `traceparent` neuf par requête
  (`worker.relay_request`). La passerelle le journalise (`runtime_link.relay_request`) et le
  relaie, le connecteur (Go) le valide, le journalise (`relay … trace=… span=…`) et le transmet
  au gateway Hermes ; une valeur invalide est écartée partout. Le worker passe entièrement par
  `@openedbot/platform-observability` (y compris le `log()` des étapes du runner) ; les lignes
  de l'API ne changent pas. Preuve : `tests/integration/run-trace-correlation.ts` (API, worker,
  passerelle et connecteur Go réels, Hermes factice : même trace-id et même span de
  `POST /v1/runs` partout) ; `make test-trace-legacy` rejoue la même preuve avec le connecteur
  publié v1.5.0, qui écarte l'en-tête sans rien casser. Point d'accroche après S2e : le
  contexte passe aujourd'hui par AsyncLocalStorage, sans toucher `runner.ts` ; une fois
  `executeRun` découpé en étapes nommées, chaque étape ouvrira son span enfant
  (`childTraceContext`) et journalisera son nom, et le contexte du run pourra être passé
  explicitement à `createRuntimeClient`.

### 4.8 Garde-fous du dépôt

- Le desktop entre dans les gardes : workspace Bun pour sa partie TS, `cargo clippy` et
  `cargo test` en CI, dependency-cruiser, `make check`.
- **Vérification pro** (Q3, non tranchée) : la recommandation reste un job CI qui construit et
  teste cœur + pro avec des références appariées, sans exposer de secret aux pull requests non
  fiables. Tant que ce job n'est pas autorisé, `make test-dual` et `make solo-check`
  (`Makefile:451-484`) sont lancés **en local** et leur résultat est consigné dans la pull request
  de chaque étape qui touche une surface utilisée par pro (D1a, S2b, S3, S4). Le desktop solo
  (section 4.2) réduit cette surface côté client.

## 5. Défaillances à traiter

| Scénario | Comportement attendu | Vérification |
|---|---|---|
| Desktop plus vieux que la version minimale de l'API | `426` + code stable, écran « mise à jour requise », bouton de mise à jour et lien de réinstallation | Test API + test du shell |
| Mise à jour : signature invalide, manifeste périmé, mauvaise architecture ou variante | Refus, version installée intacte, erreur journalisée | Tests du flux de mise à jour |
| Mise à jour : disque plein, app non inscriptible, popup encore actif | Refus avant d'écrire, popup arrêté avant le remplacement, message clair | Test sur machine de test |
| Nouvelle version qui démarre puis plante | Canal bêta avant stable ; correction par N+1, ou réinstallation du dmg précédent, gardé sous `desktop/vX.Y.Z/` (section 4.3.5). Pas de retour arrière automatique (à concevoir) | Test en canal bêta |
| Perte ou rotation de la clé de mise à jour | Procédure écrite (section 4.3.5) : copie chiffrée hors du Mac, nouvelle clé livrée par une version signée avec l'ancienne, sinon réinstallation manuelle | Exercice avant la bascule : non fait |
| Coffre indisponible (Linux sans Secret Service, Keychain verrouillé) | Session en mémoire seulement, message clair, jamais de jeton en clair sur le disque | Test Rust |
| Révocation distante ratée à la déconnexion | Session locale effacée quand même, échec journalisé | Test Rust |
| Deep link non enregistré | Repli sur la boucle locale | Test Rust |
| Popup notch absent, incompatible, ou qui plante en boucle | Arrêt immédiat si absent ou incompatible, repli durable sur la fenêtre ; sinon 5 redémarrages avec délai, puis encoche en pause jusqu’au lancement suivant (choix gardé) et dialogue ; pendant la démonstration de la première connexion, ni dialogue ni choix enregistré (section 4.3.7) | Tests du protocole et de `notch.rs` ; boucle de plantage vue sur le 1.1.4-test |
| Écran débranché entre deux lancements | Fenêtre ramenée sur un écran visible | Test Rust |
| Worker qui plante pendant la création, avant d'enregistrer l'identifiant Hermes | Run en `unknown` (`HERMES_CREATE_OUTCOME_UNKNOWN`, `queue.ts:270`), **jamais** relancé automatiquement : revue par l'utilisateur | Test d'intégration |
| Worker qui plante après l'enregistrement de l'identifiant, rejeu annoncé par l'hôte | Reprise par rejeu depuis `last_hermes_sequence`, sans doublon d'événement | Test d'intégration |
| Idem, rejeu **non** annoncé par l'hôte | Réconciliation par lecture du statut (`runner.ts:885`), puis `unknown` si l'issue reste incertaine ; l'arrêt propre du worker remet aussi le run en `polling` depuis S2d (D4) | Test d'intégration ; `run-transitions.ts`, partie 4 |
| Deux producteurs d'événements concurrents sur un même run | Séquences uniques et contiguës, curseur global ordonné | Test d'intégration concurrent |
| Run privé en `unknown` hors du trigger 0091 (sans initiateur, non racine, inséré directement en `unknown`) | Un chemin de revue existe, ou le cas est prouvé impossible. État S2b : insertion directe **impossible** en production (seule la primitive insère, statut `queued` ou `relaying`) ; tout run sans workflow qui passe en `unknown` reçoit son workflow de revue (0175) : DM racine, brouillon de persona, DM sans initiateur (agence), run entrant d'un handoff hérité, tour de salon hérité ; l'abandon libère fil, capacité et bot | `tests/integration/orphan-unknown-runs.ts` (S2a caractérisait D1, S2b prouve le chemin de revue) |
| Ancien worker qui écrit après expiration de son bail | Écriture refusée par le fencing, avant et après la reprise par un autre worker (S2d : le fencing compte aussi l'échéance du bail) | `tests/integration/run-transitions.ts`, partie 1 |
| Coupure de la connexion LISTEN | Réabonnement, rattrapage depuis le curseur durable. État S6 : `pg_terminate_backend` des deux connexions, porte TCP tenue fermée ; rien n'arrive pendant la coupure, puis les événements écrits entre-temps arrivent une fois chacun, dans l'ordre, au réabonnement (150 à 400 ms après le retour de la base, mesuré) | `tests/integration/realtime-listen.ts` (2) |
| Deux répliques d'API | Les deltas arrivent à tous les clients en < 1 s. État S6 : deux serveurs HTTP, deux hubs, deux connexions LISTEN ; le delta du worker (pré-commit vers la seule réplique visée) arrive commité à l'autre, et une écriture de l'API aux deux, en ~1 ms après le commit (local). En réel (2026-11-06, `make dev` sur develop en :8790 et une réplique de branche en :8797 sur la même base, réponse d'Atlas) : la réplique que le worker ne prévient pas reçoit chaque delta commité 6 à 21 ms (médiane 9 à 12) après la trame pré-commit de l'autre, sans doublon ; les événements écrits par l'API (`message.admitted`, `run.steering`) y arrivent 0,2 à 3,3 s plus tôt que sur develop | `tests/integration/realtime-listen.ts` (1) |
| LISTEN indisponible au démarrage | L'API démarre, journalise le repli, sert par le sondage, réessaie (1 s à 30 s) et s'abonne quand la base répond | `tests/integration/realtime-listen.ts` (3) |
| Jeton de lien volé | Ne permet plus d'imposer une nouvelle clé d'appareil | Test du gateway |

## 6. Plan par étapes

Chaque étape est une branche courte depuis `develop`, relue par `codex review --base develop`,
testée, puis fusionnée en squash. Deux pistes : **D** (desktop et console) et **S** (serveur).
Une étape ouverte par piste à la fois. Electron reste livrable jusqu'à D3.

```
 préalable :  P0 décisions restantes

 piste D :    D0 mesure --> D1a origines --> D1b chargement --> D1c streaming --> D1d virtualisation
                                 |
                                 v
              D2a prototype signé --> D2b parité macOS --> D3 release + bascule --> D4 Windows --> D5 Linux

 piste S :    S1 sûreté --> S2a..e tours et états --> S3 exécution --> S4 frontières --> S6 temps réel --> S7 corrélation
                                                                                             |
                                                                                             v
                                                                         retrait de l'interrogation à 5 s (console)
```

Dépendances entre pistes : D1a modifie l'API (origines natives, en-tête client) ; D3 dépend du
garde `426` livré en D1a ; le retrait de l'interrogation à 5 s attend S6 ; S4 attend la migration
des consommateurs pro. S5 n'est plus une étape : ses règles s'appliquent à chaque route touchée.

| Étape | Contenu | Critère de sortie |
|---|---|---|
| **P0** Préalables | Réponses à Q3 et Q7 (Q1, Q6, Q8 tranchées le 2026-11-06) | Q3 tranchée avant D1a ; Q7 avant D4 |
| **D0** Mesure | G1 (trois cas), G2, G3, G4 sur Electron et sur le web ; script rejouable | Chiffres consignés ici ; cibles confirmées ou corrigées |
| **D1a** Origines et plateforme | Adaptateur de plateforme, origine API runtime, URL publique, garde `location.origin` (console + pro), origines natives et en-tête client côté API, garde `426` | Web et Electron inchangés pour l'utilisateur ; garde au vert |
| **D1b** Chargement | Analyse du bundle (solo desktop et web de production), chargement différé, imports ciblés, budget en CI | G2 atteint ; mesure avant / après sous Electron |
| **D1c** Streaming | Store du message en cours, découpage incrémental | G4 atteint sur le web |
| **D1d** Virtualisation | Timeline virtualisée | Long fil fluide, aucune régression de lecture |
| **D2a** Prototype vertical signé | Console locale → auth bearer → SSE → notch → signature, notarisation, quarantaine → **vraie mise à jour** ; mesure de l'en-tête `Origin` ; entitlements | Le prototype installé depuis un dmg téléchargé se met à jour seul |
| **D2b** Parité macOS | Tableau de la section 4.3 entier, pont typé, tests de refus IPC | Parcours de test : connexion e-mail et Google, fil, streaming, notch, déconnexion, relance |
| **D3** Release et bascule macOS | Pipeline complet, canal bêta, puis bascule des liens de téléchargement | G1 et G3 mesurés sur l'app signée ; liens du site à jour ; Electron retiré pour macOS. **Fait pour toutes les plateformes par D6** (2026-11-06) |
| **D4** Windows | WebView2, signature (Q7) | Build CI, installation et mise à jour d'un artefact téléchargé |
| **D5** Linux | WebKitGTK, deb et AppImage, lancement sous xvfb | Build CI + parcours de test ; perf WebKitGTK mesurée |
| **D6** Retrait d'Electron | `apps/desktop` et toute trace supprimés ; Linux publié en Tauri ; Windows retiré jusqu'à D4 ; release unique macOS + Linux (section 4.3.6) | Plus aucune mention hors historique ; `release.ts` et `desktop-release.yml` vérifient sommes et signatures. **Fait** (2026-11-06), rien de publié |
| **S1** Sûreté | Refus du changement de clé implicite (après comptage en prod) ; secrets séparés ; worker aligné sur le refus de la valeur de dev | Tests de la section 5 |
| **S1b** Secrets internes séparés | Un secret par rôle (section 4.7), bascule de production par phases d'environnement avec barrières, puis repli sur l'ancien supprimé (N+1) | Tests de la section 4.7 ; production en P4 sans ancien secret ; zéro refus interne aux compteurs pendant les phases |
| **S2a** Inventaire | Inventaire des invariants des 16 écritures de `runs` ([0002](0002-invariants-des-runs.md)) | Document d'invariants relu |
| **S2b** Primitives de création | Primitives transactionnelles + commandes explicites ; trigger 0091 conservé | Garde : aucune écriture de `runs`/`workflows` hors des primitives |
| **S2c** Allocation d'événements | Une seule primitive : verrou du run puis verrou du curseur, puis calcul, dans la transaction qui insère | Garde sur `max(sequence)` hors primitive ; test de producteurs concurrents |
| **S2d** Transitions | Fonction de transition avec fencing | Tests des transitions illégales. **Fait** (2026-11-06) ; reste : transitions de `workflows` (cliquet daté) |
| **S2e** `executeRun` | Découpage en étapes nommées | Comportement identique (tests existants) + taille sous le cliquet. **Fait** (2026-11-06) |
| **S3** Propriété de l'exécution | Lectures vers `modules/runtimes` ; mutations en commandes durables du worker | Garde : l'API ne crée plus de `HermesClient` d'exécution. **Fait** (2026-11-06) |
| **S4** Frontières | Façades pour pro, exports restreints, cycles cassés, propriété des tables étendue à `apps/*`, cliquet sur les lectures étrangères | dependency-cruiser au vert ; `test-dual` et `solo-check` au vert. **Fait** (2026-11-06) ; reste : réduire les 543 lectures étrangères et les écritures inter-contextes de l'API |
| **S6** Temps réel | LISTEN par processus, trigger gardé, rattrapage durable | Tests LISTEN de la section 5 |
| **S7** Protocole et corrélation | Contrat du connecteur unique, `traceparent`, logger commun | Un run se suit d'un bout à l'autre dans les logs. **Fait** (2026-11-06) ; reste : publier edge-setup, copier `protocol/connector` dans l'image pro, spans par étape après S2e |

Chaque étape met à jour `CHANGELOG.md` (et `protocol/CHANGELOG.md` pour S1 et S7).

## 7. Risques

| Risque | Impact | Parade |
|---|---|---|
| WebKitGTK lent ou incomplet sur Linux | D5 bloquée | Linux en dernier ; Electron gardé pour Linux si la mesure de D5 est mauvaise. Décision du 2026-11-06 (D6) : Linux passe à Tauri sans attendre ; la mesure sur une vraie machine avec GPU reste à faire |
| Différences de rendu WKWebView / WebView2 / Chromium | Régressions visuelles | Parcours de test et captures sur chaque moteur à D2b, D4, D5 |
| La console embarquée prend du retard sur l'API | Erreurs chez les utilisateurs desktop | Mise à jour signée + garde `426` + fenêtre de compatibilité |
| La chaîne de distribution (notch imbriqué, notarisation, mise à jour) bloque tard | Bascule repoussée | Prototype vertical signé dès D2a |
| Le chantier casse pro | Pro cassé sans alerte | `test-dual` et `solo-check` en local consignés dans chaque PR concernée (CI pro si Q3 l'autorise), façades avant S4 |
| Desktop solo : un utilisateur pro tombe sur un écran pro dans le desktop | Écran vide ou 404 | Renvoi « Ouvrir dans le navigateur » sur les préfixes de routes pro, testé |
| Couper le changement de clé implicite bloque des hôtes légitimes | Bots injoignables | Comptage en prod avant S1, procédure de réinscription documentée |
| Trop d'étapes en parallèle | Fusions conflictuelles | Une étape ouverte par piste |

## 8. Questions ouvertes

Recommandations issues de la revue Codex ; celles marquées **(décision)** attendent l'utilisateur.

| # | Question | Recommandation |
|---|---|---|
| Q1 **tranchée** | Session et brouillons à la bascule | Reconnexion unique ; perte des brouillons annoncée ; jamais Electron et Tauri connectés en même temps avec le même refresh token |
| Q2 | Hébergement du flux de mise à jour | R2 derrière une URL publique stable, artefacts immuables, manifeste par canal / architecture / variante, clé de signature hors de l'hébergement. Proposé en D3 (section 4.3.5) : `releases.openedbot.app/desktop/v<version>/` et `desktop/solo/<canal>/latest.json`, en attente d'accord |
| Q3 **(décision)** | CI du cœur avec pro | Recommandé : job avec références appariées, sans secret exposé aux PR non fiables. En attendant : `test-dual` et `solo-check` en local (section 4.8) |
| Q4 | Librairie d'icônes à garder | Tabler (migration la plus petite), sous réserve de l'analyse du bundle, ui-kit et pro compris |
| Q5 | LISTEN | `listen` de Bun 1.4.4 d'abord ; un autre pilote seulement sur défaut reproductible |
| Q6 **tranchée** | Changement de clé d'appareil | Refus immédiat du changement implicite (après comptage en prod) ; réinscription si clé perdue ; rotation signée plus tard |
| Q7 **(décision)** | Windows | Signer avant de diffuser (certificat à acheter) ; la signature ne supprime pas à elle seule l'avertissement SmartScreen |
| Q8 **tranchée** | Variante desktop | **Solo** : pas de plugins console pro dans le desktop ; les routes pro renvoient vers le web (section 4.2) |

## 9. Ce qui n'est pas vérifié

WKWebView, la signature, la notarisation et la mise à jour sont vérifiés par le prototype D2a
(section 4.3.1), et la parité macOS par D2b (section 4.3.2). D2b n'a pas vérifié la vraie page
Google, le menu contextuel sur un champ mot de passe, `navigator.clipboard`, ni le clic sur une
notification à l'écran. WebKitGTK est vérifié sous Xvfb, en conteneur (section 4.3.3), pas sur une
machine Linux physique ni sous Wayland. Aucun test sur WebView2 ni aucun test PostgreSQL concurrent
n'a été fait. Les autres points marqués `I` restent à confirmer.

## 10. Historique de revue

**Revue Codex S1b n° 1 (2026-11-07)**, sur le plan des secrets internes : avis « à corriger »,
aucun P0. Intégré en 4.7 :
- P1 : une attente de 15 min ne prouve pas l'extinction des clés de run anciennes (reprises,
  remises en file, `unknown` réactivés) : `RUN_KEY_PREVIOUS_SECRETS` et phase P4 sur preuve en base ;
- P1 : retour arrière de P3 contradictoire avec la règle `EMIT` : ancien secret **et**
  `EMIT=split` ;
- P1 : barrières de convergence entre phases ;
- P1 : secrets Shuttle hors du paquet commun, garde dans l'entrypoint ;
- P2 : consommateurs oubliés (e2e, préprod, schéma, `scripts/env.ts`), repli d'auto-hébergement
  gardé au-delà de N+1, compteurs de refus par rôle, test d'intégration dédié (et non
  `run-trace-correlation`).

**Revue Codex S1b n° 2 (2026-11-07)** : avis « pas prêt », aucun P0. Intégré : le secret précédent
des clés de run limité à une cohorte (`RUN_KEY_PREVIOUS_CREATED_BEFORE`) ; une preuve en base par
retrait et par retour arrière, refaite après toute bascule en arrière ; barrières sur les
références de secrets de chaque tâche ; garde de l'entrypoint avant de sourcer, variables
nommées ; compteurs distincts bearer ancien / clé de run précédente ; tests de P4, des retours
arrière et d'une clé ancienne forgée pour un run récent.

**Revue Codex S1b n° 3 (2026-11-07)** : un P1 restant, intégré : la preuve de retour vers
`legacy` ne pouvait pas filtrer sur `created_at` (la clé est signée au démarrage) ; elle devient
un drain de tous les runs antérieurs à la convergence en `legacy`.

**Revue Codex n° 1 (2026-11-06)** — avis : « à corriger avant validation ». Corrections intégrées :

- Faux dans le cas courant : un message privé simple qui passe en `unknown` par un `UPDATE`
  reçoit un workflow de revue du trigger `0091_run_admission_envelope.sql:43-68`, réconciliable ou
  abandonnable. Le trigger ne résout pas l'incertitude : il donne un chemin de revue. Il exclut les
  runs sans initiateur, non racines, et ne s'applique pas à une insertion directe en `unknown` :
  ces cas restent à examiner (section 5, S2a). Retiré de S1.
- Faux : Bun 1.4 sait écouter LISTEN, et le worker l'utilise déjà avec un repli par sondage.
  S6 réécrite.
- Imprécis : 16 écritures de `runs` (et non 15) ; 12 `HermesClient` dans `apps/api/src`, pas tous
  d'exécution ; allocation de séquence et ordre du curseur sont deux sujets distincts.
- Déjà fait : la valeur de dev du secret interne est refusée en production par l'API et le
  gateway ; reste le worker.
- Ajouts : variantes solo / pro (4.2), origines natives séparées des retours OAuth, en-tête client
  dans le préflight, `"null"` jamais autorisé, bearer et `SameSite` préservés, permissions des
  commandes maison, entitlements, chaîne de signature du popup, défaillances de mise à jour,
  responsabilités Electron oubliées, perte des données locales à la bascule, consommateurs pro.
- Plan : préalable P0, prototype vertical signé au début de D2, D1 et S2 découpées, S5 dissoute
  dans chaque étape, dépendances entre pistes explicites, interrogation à 5 s gardée jusqu'à S6.
- Contre-propositions retenues : plusieurs commandes de création plutôt qu'un `startTurn` unique ;
  mutations d'exécution confiées au worker par commandes durables plutôt qu'un port appelé depuis
  l'API ; origine de l'API configurable au runtime plutôt que figée au build ; icônes après
  analyse du bundle.

**Revue Codex n° 2 (2026-11-06)** — avis : « pas encore prêt », trois précisions, intégrées :

- le trigger 0091 donne un chemin de revue, il ne résout pas l'incertitude ; ses cas exclus sont
  listés en section 5 ;
- l'allocation des séquences exige explicitement verrou du run puis verrou du curseur, avec un
  test de producteurs concurrents (4.5, S2c, section 5) ;
- la reprise après plantage du worker distingue trois cas (identifiant Hermes non enregistré,
  rejeu annoncé, rejeu non annoncé) pour ne jamais relancer une création incertaine.

**Décisions de l'utilisateur (2026-11-06)** : desktop solo (Q8), reconnexion unique avec perte
des brouillons annoncée (Q1), refus immédiat du changement de clé implicite (Q6). Q3 (CI pro) et
Q7 (signature Windows) restent ouvertes.

**Mesure de référence D0 (2026-11-06)** : chiffres en section 3.1. Cibles G1 à G4 corrigées. Le
démarrage local d'Electron est déjà sous 500 ms sur la machine de mesure (remesuré après la revue
Codex de l'outil, qui a corrigé le cas « après mise à jour » : 987 ms en réseau simulé) : G1 vise désormais
l'indépendance au réseau. G2 borne aussi le JS chargé avant la liste des fils (859 ko gzip
mesurés). G4 compte les frames longues (Long Animation Frames), l'API `longtask` ne rapportant
rien pendant le streaming.

**Inventaire S2a (2026-11-06)** : [0002](0002-invariants-des-runs.md). Chiffres confirmés (16
`insert into runs`, 14 `max(sequence)+1` sur `run_events`) ; section 4.5 précisée sur
l'allocation des séquences (le verrou du curseur sérialise les calculs faits après lui, pas ceux
faits dans la même instruction ni hors transaction). Un brouillon de persona, un handoff hérité ou
un DM d'agence sans initiateur en `unknown` n'a aucun chemin de revue (section 5, défaut D1), à
corriger en S2b. Relu par Codex (branche et document), corrections intégrées dans 0002.

**Primitives de création S2b (2026-11-06)** : section 4.5 et [0002](0002-invariants-des-runs.md)
section 9.1. Les 16 créations passent par des commandes de `modules/execution`, sans changer leurs
colonnes, leurs verrous ni leurs événements ; garde `run-writes-contract.ts` (strict pour les
créations, cliquet S2d daté au 2026-12-31 pour les transitions) et règle dependency-cruiser
`primitives-de-creation-privees`. D1 corrigé (0175). Les routes touchées gardent leur contrat HTTP :
aucune ne change de corps de requête, et la seule erreur nouvelle (`WORKFLOW_SERVICE_RETRY_UNSUPPORTED`)
est rendue par l'API ; les commandes ne lèvent aucune erreur de domaine. Le dépôt n'a pas encore de
zod : les contrats zod de section 4.6 restent à poser avec leur middleware, dans une étape qui touche
le contrat d'une route.

**Prototype D2a (2026-11-06)** : résultats en section 4.3.1. WKWebView envoie
`Origin: tauri://localhost`, accepté par le CORS de D1a ; aucun entitlement ; mise à jour réelle
0.0.1 → 0.0.2 depuis un dmg notarisé, signature étrangère refusée. Le flux SSE manquait d'en-têtes
CORS (corrigé dans la même étape).

**Allocation d'événements S2c (2026-11-06)** : section 4.5 et [0002](0002-invariants-des-runs.md)
section 9.2. Une primitive (`sql/run-events.ts`) prend la ligne de chaque run visé
(`for no key update`, qui ne bloque pas les clés étrangères), puis le curseur de l'organisation,
puis lit `max(sequence)` dans une instruction distincte, dans la transaction qui insère. D2 corrigé
(un `run.error` de balayage n'est plus perdu), D3 corrigé (une collision du flux devient une erreur
nommée ; la course réelle, un avis de complétion qui prenait la place d'un `tool.result.attached`,
n'est plus possible). Le balayage des runtimes connecteurs injoignables passe de `runtime-link` à
`execution`, propriétaire des tables qu'il écrit. Aucune migration.

**Transitions S2d (2026-11-06)** : section 4.5 et [0002](0002-invariants-des-runs.md) section 9.3.
Une fonction (`sql/run-transitions.ts`) écrit seule `status`, `external_state` et
`remote_stop_state`, d'après une table déduite de 0002 section 7 et testée paire par paire ; le
fencing du worker ajoute l'échéance du bail au propriétaire et à la génération. Les 66 écritures de
`runs` du cliquet passent par elle ou par une écriture nommée ; la garde est stricte. Corrigés : D4
(arrêt du worker remis en `polling`), D6 (courrier clos sous garde : la double livraison est
reproduite sur le code d'avant), D9 (abandon et relance règlent l'état externe). D5, D7, D8, D10,
D11 restent ouverts (verrous de route, admission, données héritées). Aucune migration.

**Parité macOS D2b (2026-11-06)** : résultats en section 4.3.2. Le tableau de la section 4.3 est
couvert sur l'app signée et notarisée, à l'exception des points listés pour D3. L'état de mise à
jour est exposé par le pont et au notch. Plusieurs passes de `codex review` ont été faites ; leurs
findings P1/P2 ont été corrigés dans la branche :
- purge non confirmée, purges concurrentes ;
- écritures de préférences concurrentes ;
- réinstallation après « Plus tard » ;
- popup relancé pendant l'installation ;
- espace des feux au zoom du menu ;
- clic sur une notification ;
- processus de popup qui se chevauchent ;
- masquage d'une URL entre parenthèses ;
- refresh lancé avant la fenêtre.

**Découpage S2e (2026-11-06)** : section 4.5 et [0002](0002-invariants-des-runs.md) section 9.4.
`executeRun` passe de 1 331 à 91 lignes ; huit modules d'étape, aucun au-delà de 304 lignes, et un
état partagé explicite (`RunState`) pour les minuteries. Même ordre des écritures, mêmes verrous,
événements et journaux : les tests existants passent sans changement, le golden des portes est
inchangé ; tests ajoutés pour la complétion d'une trame et l'échéance du workflow. Relevé sans
correction : un double enveloppement du message de repli à la création, latent tant qu'un refus de
création ne peut pas être classé `quota`. Aucune migration.

**Propriété de l'exécution S3 (2026-11-06)** : section 4.6. Sur 13 `HermesClient` de l'API, douze
lisent ou administrent l'hôte et passent par `runtimeAdminClient` (sans verbe d'exécution) ; la
nouvelle version d'un message était déjà un run du worker. La compaction d'un salon devient la
commande durable `thread.compact` (`execution_commands`, migration 0176), exécutée par le worker
sous bail clôturé ; la route rend la même réponse en attendant le règlement. Garde
`runtime-client-contract.ts` ; test `tests/integration/execution-commands.ts` (doublon, API perdue
avant la réclamation, reprise après la mort d'un worker, tentatives épuisées, arrêt propre,
annulation, run concurrent, tenant, rétention). Les invariants des runs (0002) ne changent pas.
Onze passes de revue Codex ; la dernière relève la limite connue de la section 4.6.

**Mises à jour D2c (2026-11-06)** : résultats en section 4.3.4. Téléchargement silencieux,
pastille bleue, consentement ou inactivité, double « requise » (426 et manifeste), notch. Éprouvé
sur l'app signée et notarisée de 0.0.19 à 0.0.26. Sept passes de `codex review` (la dernière
sans finding) ; leurs findings P1/P2 ont été corrigés dans la branche :
- conditions d'inactivité relues avant et après l'arrêt du popup ;
- écran requis sans rien à installer, et vérification déjà en cours au clic ;
- dialogue fermé sous l'écran requis ;
- compte des runs tenu à jour en arrière-plan ;
- version suffixée refusée par `install_update` ;
- écran requis bloqué quand la même erreur revient ;
- compte des runs en cache qui n'expirait pas pendant une panne.
Corrigé après l'épreuve sur l'app signée : une signature refusée était retéléchargée à chaque
vérification et son erreur disparaissait de Réglages.

**Frontières S4 (2026-11-06)** : section 4.6. Façades `application` pour les sept fichiers SQL
que pro lisait, pro migré (branche `refactor/s4-core-facades`, à fusionner avec le cœur), puis
`./sql/*` retiré des exports et tenu privé par dependency-cruiser. Les deux cycles de paquets
cassés (ports `BotRuns` et `TenantPurgeProfileJobs`, arguments obligatoires, déplacements vers le
roster et `runtimes`) ; graphe déclaré sans cycle, gardé. Propriété des tables étendue à
`apps/*` (36 tables écrites par l'API ou le worker, writers déclarés) ; 553 lectures étrangères
gelées par un cliquet, 543 après réduction. `bot-host` et la sonde d'enrôlement passent par
`runtimeAdminClient`. `make solo-check` (deps-check, test-dual) au vert hors des trois
« silhouettes du cadre » connues en mode pro ; `make test-integration` au vert. Une passe de
`codex review` par dépôt, sans finding. Aucune migration.

**Release et bascule macOS D3 (2026-11-06, prête à publier)** : section 4.3.5. Identité de production
(celle d'Electron), flux hébergé par canal proposé (Q2), pipeline GitHub qui recopie le dmg depuis
R2, annonce dans Electron prête mais éteinte, 1.1.0 signé, notarisé et agrafé, rien de publié.
Quatre passes de `codex review` ; leurs findings P1/P2 ont été corrigés dans la branche :
- alerte de configuration refusée qui bloquait la boucle d'événements ;
- dossier de sortie de `release-mac.ts` effacé sans garde (option retirée) ;
- sonde d'accessibilité synchrone qui bloquait le relais d'API qu'elle mesurait ;
- dmg recopié par la CI sans contrôle de l'équipe de signature (`TeamIdentifier` vérifié) ;
- arrêt de `perf-mac.ts` en préparation qui laissait tourner ce qu'il avait lancé.
Mesuré sur le 1.1.0 signé : G1 604 / 540 / 557 ms en local (premier, suivant, après mise à
jour), 1 256 / 637 / 754 ms en réseau simulé ; G3 456 Mo. Cibles manquées sauf « après mise à
jour » en local ; mémoire −31 % et premier lancement en réseau meilleurs qu'Electron. Mise à jour
réelle 1.1.0 → 1.1.1-test réussie (signature vérifiée, toujours notarisée, point du notch),
manifeste signé par une autre clé refusé, `openedbot://` reçu par l'app installée.
Retour de l'utilisateur : feux tricolores décentrés (14 pt contre 23 × zoom). Corrigés, mesurés de
0,71 à 1,33 (écart au centre de la barre ≤ 0,5 pt), 1.1.0 reconstruit, renotarisé, revérifié.
Le notch actif par défaut et son choix dans les Réglages sont en attente : le comportement cible
viendra de l'analyse du notch d'OpenBot (patch gardé hors du dépôt).

**Electron retiré (D6, 2026-11-06)** : section 4.3.6. `apps/desktop` et toute trace d'Electron
supprimés du code, du build, de la CI et des docs ; le pont natif n'existe plus que dans le build
desktop, une app 1.0.x se comporte comme un navigateur après le déploiement de la console (prouvé
dans Chromium, pont 1.0.3 simulé). Linux publié en Tauri (identité de production, deb qui
remplace `openedbot-desktop`, éprouvé par apt et dpkg dans Ubuntu 24.04), Windows retiré jusqu'à
D4. Une seule release macOS et Linux (`release.ts`, signatures vérifiées contre `updater.pub`),
pipeline GitHub qui vérifie puis publie depuis R2. Rien de publié. `make solo-check` au vert hors
des trois « silhouettes du cadre » connues en mode pro ; une passe de `codex review`, sans
finding.

**Encoche à la première connexion D3b (2026-11-06)** : section 4.3.7. Démonstration de deux bots
fictifs et choix « Garder l'encoche » / « Pas maintenant » à la première connexion sur Mac, l'encoche
seulement avec une session, Réglages › Encoche, pause au lieu d'un retrait après un plantage en
boucle, écran de la caméra et replacement au réveil ; mise à jour dans le rail d'icônes, bleu
systemBlue pour toutes les indications de mise à jour, aucun contour de focus dans l'app de bureau.
Éprouvé sur des builds signés 1.1.4-test à 1.1.12-test, sauf Échap et le réveil (tests). Revues
`codex review` jusqu'à une passe sans finding : 5 passes pour l'app, 17 pour openedbot-notch.
Rien de publié.
