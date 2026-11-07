# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/).
Ce journal couvre l'application openedbot (console, API, worker). Le
connecteur hôte et le protocole tiennent le leur :
[`edge-setup/CHANGELOG.md`](edge-setup/CHANGELOG.md) et
[`protocol/CHANGELOG.md`](protocol/CHANGELOG.md).

## Non publié

### Sécurité

- **Un secret interne par usage au lieu d'un seul.** L'API, le worker et la
  passerelle de lien partageaient `WORKER_INTERNAL_TOKEN` pour tous leurs
  appels internes et pour signer les clés de run des outils MCP : une fuite
  depuis n'importe lequel des trois donnait tout. Chaque usage a désormais son
  secret, et chaque processus ne détient que les siens :
  `EVENTS_INTERNAL_TOKEN` (publication d'événements, API et worker),
  `RELAY_INTERNAL_TOKEN` (relais du lien, les trois), `INVENTORY_INTERNAL_TOKEN`
  (signal d'inventaire, API et passerelle) et `RUN_KEY_SECRET` (clés de run,
  API et worker, jamais un bearer). La passerelle, seul processus exposé aux
  hôtes, ne peut plus ni publier d'événements ni signer de clé de run. Chaque
  route interne refuse le secret des autres rôles ; les refus se comptent par
  rôle (journal `internal_auth.*`, `/internal/metrics` de l'API), sans jamais
  journaliser de secret.
  **Auto-hébergement : action requise avant de mettre à jour.**
  `WORKER_INTERNAL_TOKEN` n'est plus lu, et un processus qui le trouve encore
  refuse de démarrer en disant quoi faire. Pour migrer :
  1. générer quatre secrets distincts (`openssl rand -hex 32`) et les poser :
     les quatre sur l'API, `EVENTS_INTERNAL_TOKEN`, `RELAY_INTERNAL_TOKEN` et
     `RUN_KEY_SECRET` sur le worker, `RELAY_INTERNAL_TOKEN` et
     `INVENTORY_INTERNAL_TOKEN` sur la passerelle ;
  2. pour que les runs en cours gardent leurs outils MCP, poser aussi sur
     l'API `RUN_KEY_PREVIOUS_SECRET` (l'ancienne valeur de
     `WORKER_INTERNAL_TOKEN`) et `RUN_KEY_PREVIOUS_CREATED_BEFORE` (l'instant
     de la bascule, en UTC, par exemple `2026-11-07T12:00:00Z`) ;
  3. retirer `WORKER_INTERNAL_TOKEN`, puis mettre à jour et redémarrer l'API,
     le worker et la passerelle ensemble ;
  4. une fois terminés les runs créés avant cette date, retirer les deux
     variables `RUN_KEY_PREVIOUS_*`.
  Le même couple sert ensuite à faire tourner `RUN_KEY_SECRET` sans casser
  les runs déjà en cours (pendant un déploiement progressif, une API pas
  encore à jour refuse les clés des runs lancés par un worker déjà à jour,
  le temps qu'elle converge). Détail : `docs/architecture/0001-refonte-tauri-et-produit.md`,
  section 4.7.

## 1.1.1 — 2026-11-06

### Ajouté

- **openedbot 1.1.1 : l'app de bureau devient native, sur Mac et sous
  Linux.** La console est embarquée au lieu d'être téléchargée à chaque
  ouverture, et l'app se met à jour seule (pastille bleue « Mettre à jour »,
  redémarrage avec votre accord ; sous Linux, l'AppImage se met à jour seule,
  le paquet deb par l'installation du suivant). Sur Mac, elle occupe environ
  un tiers de mémoire en moins (456 Mo contre 660 Mo, fil ouvert) et ses
  boutons de fenêtre restent centrés sur la barre du haut, quelle que soit la
  taille du texte. Le notch, la connexion par e-mail ou Google, les
  notifications et le raccourci ⌘⇧O sont repris. Sous Linux : un deb et une
  AppImage, pour x86_64 et désormais aussi pour ARM (arm64), avec l'icône
  dans la zone de notification.
  **L'app de bureau Windows n'est plus proposée pour l'instant**, le temps
  de livrer sa version native ; la console web reste disponible dans le
  navigateur.
  **L'ancienne app de bureau (versions 1.0.x) ne se met pas à jour toute
  seule : remplacez-la par le nouveau téléchargement.** Sur Mac, le dmg
  s'installe à la même place dans Applications ; sous Linux, le nouveau deb
  remplace l'ancien paquet (`sudo apt install ./openedbot-linux-amd64.deb`).
  Une fois la console web mise à jour, l'ancienne app affiche « Cette
  version d'openedbot n'est plus prise en charge », avec les liens de
  téléchargement et « Continuer dans le navigateur ». **À l'installation, une seule fois** : il faut se
  reconnecter, et les brouillons non envoyés de l'ancienne app ne sont pas
  repris (envoyez-les ou copiez-les avant de la remplacer).

- **Sur Mac, l'encoche se présente à la première connexion.** Juste après
  vous être connecté dans l'app de bureau, une courte démonstration joue en
  haut de l'écran avec deux bots fictifs (Recherche et Rédaction : travail en
  cours, demande d'accord avec « Autoriser » / « Refuser », puis terminé),
  sans rien envoyer ni notifier, et une fenêtre propose « Garder l'encoche »
  (l'encoche et la fenêtre) ou « Pas maintenant » (la fenêtre seule). Fermer
  l'app sans choisir reposera la question au lancement suivant ; une mise à
  jour ne la repose jamais. Après la démonstration, vos notifications et vos
  demandes d'accord en attente reviennent, et la réponse d'un bot reçue
  pendant qu'elle jouait s'annonce une fois. Le choix se change dans le nouveau volet
  Réglages › Encoche, qui permet aussi de revoir la démonstration, ou depuis
  le menu du Dock (« Fenêtre », « Encoche seule », « Fenêtre et encoche »).
  L'encoche n'apparaît plus avant la connexion, se place sur l'écran qui a
  la caméra et se replace au réveil. Quand elle s'arrête plusieurs fois de
  suite, elle reste fermée jusqu'au prochain lancement, qui la relance, au
  lieu de vous remettre définitivement sur la fenêtre seule.
- **La mise à jour de l'app de bureau se voit dans le rail d'icônes** : un
  bouton juste au-dessus de Réglages, qui ouvre « Mise à jour prête ». Toutes
  les indications de mise à jour (ce bouton, la pastille « Mettre à jour »,
  le point de l'encoche) prennent le bleu des mises à jour d'Apple, plein,
  sous une icône blanche, lisible en thème sombre.

- L'app de bureau indique sa version à l'API. Quand une version devient
  trop ancienne pour être servie, l'app affiche « Mettez openedbot à jour »
  avec un lien vers la page de téléchargement, au lieu d'erreurs en cascade.
  Le seuil se règle côté serveur (`DESKTOP_MIN_VERSION`, vide par défaut :
  aucune version n'est refusée).
- L'API accepte les requêtes de la future app de bureau, dont la console
  sera embarquée : ses origines locales passent le CORS sans jamais pouvoir
  utiliser un cookie de session, et le numéro de référence d'une erreur reste
  lisible.
- Réglages › Archives : chaque section (corbeille, bots archivés,
  conversations masquées) s'affiche par pages de 15. Une case par ligne,
  une case pour cocher la page entière et « Tout sélectionner » pour toute
  la section. La sélection se restaure, s'affiche ou se supprime
  définitivement d'un coup. La suppression demande toujours confirmation,
  et un élément en échec reste sélectionné pour réessayer.

### Modifié

- **L'app de bureau n'affiche plus de contour de focus** sur les boutons,
  champs, onglets et menus, même au clavier ; la navigation au clavier
  fonctionne comme avant. La console dans le navigateur ne change pas.
- Un message se suit d'un bout à l'autre dans les journaux d'exploitation.
  Son run porte un identifiant de trace (l'identifiant du run sans ses
  tirets), présent sur la ligne `run.admission` de l'API, sur chaque ligne
  du worker pendant le run (`worker.run_claimed`, les étapes, `run.latency`),
  sur une nouvelle ligne par requête envoyée à l'hôte
  (`worker.relay_request`, `runtime_link.relay_request` côté passerelle) et
  dans le journal du connecteur à partir de la prochaine version
  d'edge-setup ; l'en-tête `traceparent` (W3C) le porte jusqu'à Hermes. Le
  worker écrit désormais ses journaux comme l'API (pino : JSON horodaté et
  nivelé en production, lisible en développement, mêmes noms d'événements et
  mêmes champs) au lieu de lignes `console` ; les lignes de l'API ne changent
  pas, `run.admission` gagne seulement `traceId`. Un connecteur déjà installé
  continue de fonctionner : il ignore l'en-tête.
- Le direct ne dépend plus de la réplique d'API à laquelle on est connecté.
  Chaque réplique écoute les nouveaux événements dans PostgreSQL (LISTEN) :
  une réponse qui s'écrit, une annulation ou un message ajouté par l'API
  arrivent à tous les clients quelques millisecondes après leur
  enregistrement, au lieu d'attendre
  jusqu'à 5 s le sondage de secours sur les répliques que le worker ne
  prévient pas, ou pour les événements écrits par l'API elle-même. Après une
  coupure de la connexion, la réplique se réabonne seule et relit ce qui
  s'est passé entre-temps, sans perte ni doublon. Si l'écoute est
  indisponible, l'API démarre quand même, le signale dans ses journaux et ses
  métriques, et retombe sur l'ancien chemin (alerte du worker, sondage).
- La console s'ouvre plus vite : avant d'afficher la liste des fils, elle
  télécharge moitié moins de code (environ 390 ko compressés au lieu de
  860) et en 27 fichiers au lieu de 54. L'écran de conversation, la page
  d'un bot, la palette ⌘K, le guichet de support, les notes de version du
  connecteur, les graphiques et la table de la Vue d'ensemble, et le rendu
  des formules (KaTeX) se chargent quand on les ouvre. Le dictionnaire de la
  langue active part en même temps que l'application. Avec une latence
  réseau de 50 ms, le premier lancement passe d'environ 1,2 s à 0,9 s dans
  le navigateur, et le premier lancement après une mise à jour d'environ
  1 s à 0,65 s dans l'app de bureau.
- Une réponse qui s'écrit ne fait plus travailler tout l'écran : seule sa
  bulle suit le texte, et le reste de la conversation (en-tête, liste des
  fils, fil) se met à jour une fois par seconde au plus pendant qu'elle
  s'allonge. Les mots déjà apparus ne gardent plus leur animation, et le
  rail des tours mesure le fil dix fois par seconde au plus. Sur un
  processeur ralenti quatre fois, comme sur une machine modeste, une longue
  réponse s'affiche à 85 images par seconde environ au lieu de 50 à 57.
  Pendant l'écriture, la recherche dans le fil et l'aperçu de la liste des
  fils suivent la réponse avec au plus une seconde de retard.
- Un long fil reste fluide, même après avoir chargé tout son historique.
  Seuls les tours visibles, avec un écran de marge, sont affichés ; les
  autres gardent leur place, et la barre de défilement ne saute plus. Avec
  750 tours chargés, le défilement reste à 120 images par seconde au lieu
  de 92 (avec des creux à 30), et la page occupe 34 Mo de mémoire au lieu
  de 115. La lecture ne change pas : le fil reste en bas pendant une
  réponse, et charger les messages précédents ne déplace plus le message
  qu'on lit. Un lien vers un message, la recherche (⌘K et ⌘F) et le rail
  des tours atteignent aussi un tour lointain. Une sélection de texte ou le
  focus clavier gardent leurs tours affichés : copier plusieurs messages
  fonctionne toujours. « Charger les messages précédents » annonce
  désormais 40 messages, la taille réelle d'une page.
- Plus aucun nom technique hérité de l'ancien nom du produit : base et rôles
  PostgreSQL, fonctions SQL, en-têtes, cookies, schéma d'URL de l'app de
  bureau (`openedbot://`), popup natif (`OpenedbotPopup.app`), classes CSS,
  métriques, chemins et fichiers s'appellent tous openedbot. Chacun est
  déconnecté une fois (cookies renommés) et les préférences locales de la
  console repartent de zéro. Une machine déjà liée doit être liée à nouveau
  avec le connecteur mis à jour : le lien a changé de format.
- Les notifications s'affichent en bas à droite partout, réglages compris.
- Réglages › Politiques : « Mentions légales », « Politique de
  confidentialité » et « Conditions d'utilisation » s'ouvrent sur le web,
  dans le navigateur (celui du système depuis l'app de bureau), et non plus
  dans l'application.
- Mon compte : plus d'avatar à initiales devant le nom affiché ni devant
  les membres.
- **Nouveau logo : le bloub.** La mascotte openedbot passe au bloub, en
  vectoriel : favicon (clair ou sombre selon le navigateur), logo de l'app et
  de la connexion, icône de l'app de bureau sur macOS, Linux et Windows,
  icône de la barre des tâches Windows, en-tête des e-mails et site de
  documentation. Sur le bureau, le bloub est posé sur une tuile blanche pour
  rester visible sur un Dock ou un lanceur sombre. L'ancienne mascotte (le
  chat masqué) est retirée.
- Application de bureau macOS (1.0.3) : les versions publiées sont signées avec un
  Developer ID et notarisées par Apple. Le dmg téléchargé s'ouvre sans
  alerte, sans passer par « Ouvrir quand même » dans Réglages › Confidentialité
  et sécurité. Les builds des pull requests restent signés ad hoc.
- « Compacter l'historique du salon » s'exécute désormais dans le worker,
  comme une réponse, et plus dans la requête de la console. Fermer l'onglet
  ou le dialogue n'arrête plus un résumé déjà lancé : il se termine et
  l'historique se met à jour. Un seul résumé par salon à la fois, quelle que
  soit la réplique d'API qui reçoit la demande ; un résumé interrompu par un
  redémarrage du worker reprend sur un autre. La réponse ne change pas.
  Nouveaux cas, chacun avec son message : `COMPACTION_NOT_STARTED` (aucun
  worker n'a pris le résumé), `COMPACTION_STILL_RUNNING` (le résumé continue
  au-delà de l'attente de la requête), `COMPACTION_CANCELLED` (arrêté par
  `DELETE /api/threads/:threadId/compact`).

### Corrigé

- Un travail dont l'issue est devenue incertaine (le worker s'est arrêté
  pendant sa création chez Hermes, par exemple) ne bloque plus sa
  conversation sans recours : un brouillon de persona, un message transmis
  par un ancien `@bot`, un ancien tour de salon ou un message d'un opérateur
  dont le compte a été supprimé apparaît désormais « à vérifier » dans la
  boîte de réception, comme un message privé. L'abandonner libère la
  conversation, le bot et la place qu'il occupait chez le runtime. Un
  brouillon de persona ne se relance pas d'ici (on le relance depuis la
  fiche du bot), ni un message transmis (on le renvoie).
- Un travail « à vérifier » qu'un administrateur abandonne (ou remplace par
  une relance) ne s'affiche plus « à vérifier » dans sa conversation : il
  apparaît en échec, comme dans la boîte de réception.
- Un message transmis à un autre bot par un ancien `@bot` ne reçoit plus sa
  réponse en double quand on annule la conversation au moment même où le
  bot répond : le fil d'origine reçoit une seule réponse.
- Un message repris après l'arrêt d'un worker (mise à jour, redémarrage)
  relit d'abord l'état du run chez Hermes quand le runtime n'annonce pas de
  rejeu, comme après la perte de son bail, au lieu de se raccrocher au flux
  en cours sans savoir ce qu'il a manqué.
- Un worker dont le bail a expiré n'écrit plus rien sur le message qu'il
  traitait, même si aucun autre worker ne l'a encore repris : sa réponse
  tardive ne peut plus clore un message que la reprise va réconcilier.
- Les mises à jour en direct (réponses en cours, fils, notifications) arrivent
  aussi à la future app de bureau, dont la console est embarquée : le flux
  temps réel portait l'en-tête CORS des autres requêtes de l'API sauf le sien,
  et l'app se reconnectait sans fin. Le web et l'app actuelle, servis depuis
  l'origine de la console, n'étaient pas touchés.
- Un message en échec s'affiche toujours dans sa conversation. Quand le
  runtime ne répondait plus et qu'un autre événement arrivait au même
  instant sur le même message, son erreur pouvait disparaître du fil : le
  message était marqué en échec, mais le fil ne le montrait qu'après
  rechargement. De même, le résultat d'un outil rattaché à la fin d'une
  réponse ne se perd plus quand la réponse ajoute un avertissement (une
  délégation hors plateforme, par exemple). Si deux écritures se disputent
  encore la même place dans le journal d'un message, le message échoue avec
  une erreur nommée (`RUN_EVENT_SEQUENCE_CONFLICT`) au lieu de perdre un
  événement en silence.
- Réglages › Activité : sans aucun bot, le tableau propose « Créer un bot ».
  L'ancien message renvoyait vers la barre latérale, absente de cet écran.
- Le panneau latéral (Réflexions, pièce jointe, contexte) s'ouvre de
  nouveau en glissant depuis le bord : il ne saute plus d'un coup à 320 px
  en décalant le fil.
- **Chargement d'une conversation au rechargement.** La silhouette affichée
  avant les données reprend la forme du fil : bulles de questions et de
  réponses avec leur rangée d'actions, composer à sa taille réelle, titre
  centré dans la barre du haut, quotas GPT, Anthropic et Grok à leur place
  dans le rail, bloub dans la barre de titre du bureau. Le passage à la
  conversation chargée ne fait plus sauter l'écran.
- Réglages › Archives : les boutons des lignes reprennent ceux des autres
  réglages, comme dans Runtime. « Restaurer » et « Afficher » sont des
  pilules neutres, « Supprimer définitivement » une pilule rouge pleine.
- La page introuvable (404) et l'écran de changement de mot de passe
  affichent désormais « openedbot » à côté du logo.

### Retiré

- Les anciens noms d'en-têtes de requête et de relais ne sont plus lus.
- Mon compte : la carte « Session » et son bouton « Se déconnecter » ; la
  déconnexion reste en bas de la barre latérale des réglages.
- Réglages › Connecteurs : le catalogue ne propose plus que Notion, Linear
  et Cloudflare. Netlify, Todoist, PayPal, Attio, Calendly, Webflow,
  Supabase, Sentry et GitLab en sont retirés. Un de ces serveurs déjà
  connecté sur un hôte n'est pas touché : il apparaît comme un serveur
  ajouté à la main.
- Derniers restes de l'ancienne PWA dans la console : le titre Apple de
  l'écran d'accueil, la directive `manifest-src` de la CSP et les textes
  d'installation et de notifications push qui n'étaient plus affichés. Le service
  worker de retrait (`/sw.js`) reste en place pour désinscrire les anciennes
  installations.
- Le filet de sécurité des anciens noms de variables d'environnement
  (d'avant le préfixe `OPENEDBOT_`) : l'API, le worker, la passerelle de
  lien, l'app de bureau, le Makefile et les scripts ne refusent plus de
  démarrer quand l'un d'eux est posé, et `make env-prune` ne les réécrit
  plus sous leur nouveau nom. Un ancien nom est simplement ignoré.


### Sécurité

- Une machine liée ne peut plus changer de clé d'appareil par son lien :
  openedbot refuse toute autre clé que celle enregistrée à l'enrôlement, même
  présentée avec le jeton de lien courant. Un jeton de lien volé ne suffit
  donc plus à imposer la clé d'un attaquant. Pour donner une nouvelle clé à
  une machine, on la réenrôle (Réglages › Runtime › Remplacer le runtime).
  Deux montées simultanées d'une machine sans clé ne peuvent plus non plus
  s'écraser l'une l'autre.

## 1.0.2 — 2026-11-04

### Corrigé

- **Quotas du rail au rechargement.** Les logos GPT, Anthropic et Grok
  tiennent leur place dès l'ouverture, estompés, le temps de la première
  lecture, puis leurs anneaux se remplissent sur place. Ils n'apparaissent
  plus d'un coup une à deux secondes après le reste du rail.

## 1.0.1 — 2026-11-04

### Ajouté

- **Panneau Réflexions.** Un clic sur « Réflexion : Ns » au-dessus d'une
  réponse ouvre le journal du tour dans le panneau de droite : ce que le bot a
  dit entre ses étapes, ses recherches web avec les pages trouvées, ses outils
  et, dépliée, l'erreur d'un outil en échec.
- **Planifier d'abord.** Le menu « + » du composer propose de demander un plan
  avant d'agir, pour les messages de cette conversation seulement. Le bot
  propose un plan sans rien modifier ; « Lancer » l'exécute ensuite avec ses
  règles habituelles. Ses autres conversations et ses routines ne changent pas.
- Un indicateur dans l'en-tête d'une conversation signale un bot en Mode plan
  ou en Accès complet, y compris quand l'organisation en réduit l'effet. Un
  clic ouvre ses règles d'approbation.
- Réglages › Apparence › Accent : dans la conversation d'un bot, les boutons
  et le focus prennent la couleur du bot, ou gardent l'accent de l'application.
- Le menu du compte affiche le quota fournisseur le plus entamé.
- Les résultats de recherche disent qui a écrit, à qui, et quand.

### Modifié

- Le fil et le composer d'une conversation reprennent ceux de grok.com, en
  clair comme en sombre : pendant le run, les étapes défilent sous
  « Réflexion • Ns » (messages du bot, recherches, outils) ; la réponse
  arrive mot à mot dans une bulle, la rangée d'actions dessous.
- Couleurs des bulles reprises de Grok Bot : la bulle de l'utilisateur prend
  la couleur du bot de la conversation.
- L'en-tête « Réflexion » d'un tour tient sur une ligne et ne montre plus
  qu'un compte d'échecs, jamais la sortie brute d'un outil.
- Le code en ligne d'une réponse reste lisible en thème sombre.
- Envoyer un message ne fait plus sauter le fil.
- Application de bureau Linux : la fenêtre et le lanceur affichent l'icône
  d'openedbot.
- La barre latérale suit les quotas GPT, Anthropic et Grok (abonnement
  SuperGrok / Premium+ compris, marqué Grok) à la place du menu du compte ;
  un clic ouvre le relevé complet.
- Le mode de permission d'un bot se règle dans sa fiche (Règles
  d'approbation) et plus depuis le composer : c'est une règle du bot, valable
  pour toutes ses conversations et ses routines.
- Nouveau thème des conversations, en clair comme en sombre :
  - bulles, groupement des messages, blocs de code avec bouton de copie et
    couleurs de syntaxe revues ;
  - largeur de lecture alignée avec le composer ;
  - animations d'arrivée des messages et d'ouverture du composer.
- Les actions d'un message (copier, citer, réagir…) passent dans un menu
  contextuel : clic droit, ou appui long sur téléphone.
- Barre latérale : lignes de conversation plus grandes, en-têtes de section
  revus.
- Taille de texte par défaut : 14 px.
- Sans choix explicite, le modèle proposé d'office est celui de la gamme
  courante d'une famille (Sonnet, Luna, Flash), jamais son haut de gamme.

### Retiré

- Le bouton micro du composer et la fenêtre vocale qu'il ouvrait (dictée et
  appel). La lecture à voix haute des réponses reste.
- Le compte agence de démonstration du jeu de données de développement.
