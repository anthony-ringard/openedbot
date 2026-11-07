# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/).
Les releases sont servies par `https://releases.openedbot.app/edge-setup`.
Chaque entrée est le texte public de la release : il parle produit, sans
ticket, route interne, code d'erreur ni chemin de l'hôte (`make notes-check`).
Le détail technique vit dans les commits et `docs/CONNECTOR.md`.

La numérotation repart de v0.0.1 avec le dépôt autonome et la nouvelle origine
de téléchargement. Les versions v0.2.0 à v1.4.0, publiées depuis l'ancien
dépôt, restent listées plus bas pour l'historique. Depuis v1.5.0, chaque
nouvelle version passe au-dessus de v1.4.0 : un numéro ne désigne plus jamais
deux releases différentes.

## Non publié

## v1.5.2 - 2026-11-07

### Changé

- La mise à jour automatique est désormais activée par `up` sous Linux : toutes les 6 h, la machine installe seule une version plus récente d'edge-setup, jamais pendant que vos bots travaillent, vérifie que le lien revient et remet l'ancienne version sinon. Pour la refuser, `up --no-auto-upgrade` ou `auto-upgrade disable --yes` ; ce refus est retenu, et les `up` suivants laissent la machine telle quelle jusqu'à `auto-upgrade enable --yes`. Une machine qui l'avait déjà désactivée reste désactivée.
- La machine dit à openedbot si sa mise à jour automatique est active, et le redit quand cela change sans couper le lien : la console affiche alors, à côté d'une mise à jour disponible, si la machine l'installera seule ou la commande qui l'active.

## v1.5.1 - 2026-11-06

### Ajouté

- Chaque échange d'une conversation porte désormais l'identifiant de suivi qu'openedbot lui donne, et le connecteur l'inscrit dans son journal avant de le transmettre à l'agent. Un incident se retrouve ainsi d'un bout à l'autre, de la conversation jusqu'à la machine. Rien à faire après la mise à jour ; une version plus ancienne d'edge-setup continue de fonctionner sans ce suivi.

### Changé

- `link --rekey` est retiré : openedbot ne remplace plus la clé d'appareil d'une machine déjà liée, pour qu'un jeton de lien volé ne suffise jamais à en imposer une autre. Pour donner une nouvelle clé à une machine, la réenrôler avec un nouveau ticket depuis Réglages › Runtime › Remplacer le runtime. La commande refuse désormais sans rien modifier, au lieu de remplacer la clé de la machine avant de la présenter. Ne pas lancer l'ancienne commande avant cette mise à jour ; une machine où elle a déjà été lancée se réenrôle de la même façon.

## v1.5.0 - 2026-11-06

Même edge-setup que v1.1.0, sous un numéro que l'ancien dépôt n'a jamais utilisé. Une machine en v1.1.0 passe en v1.5.0 avec une mise à jour ordinaire.

### Changé

- La numérotation passe au-dessus des versions de l'ancien dépôt (jusqu'à v1.4.0) : une machine qui affichait une de ces versions voit désormais clairement la plus récente.
- Chaque version est publiée à l'identique sur l'origine de téléchargement et en release GitHub du dépôt openedbot, avec les mêmes fichiers signés et les mêmes empreintes.

## v1.1.0 - 2026-11-05

Le lien avec openedbot change de format. Une machine déjà liée met à jour edge-setup puis se lie à nouveau avec un nouveau ticket.

### Changé

- L'adresse d'openedbot se donne avec `--openedbot` (et `--insecure-openedbot` en développement). Le lien et l'audit de création changent de format : une machine déjà liée doit être liée à nouveau, avec un nouveau ticket, après la mise à jour.

### Ajouté

- Les quotas d'un abonnement xAI (SuperGrok, Premium+) remontent dans openedbot, comme ceux d'Anthropic, d'OpenAI et d'OpenRouter.

## v1.0.0 - 2026-11-03

Première version stable d'edge-setup, publiée avec l'ouverture d'openedbot à tous. Elle reprend tout ce qu'apportait v0.0.5, sans changement de comportement.

### Changé

- Le numéro de version passe à 1.0.0. Une machine en v0.0.x voit cette version comme une mise à jour et peut la prendre avec `edge-setup upgrade`.
- La console d'openedbot lit désormais la dernière version publiée directement à la source des téléchargements : « mise à jour disponible » apparaît dès qu'une nouvelle version sort, sans intervention de notre part.

### Migration

- Une machine encore équipée d'une version de l'ancien dépôt (v1.0.0 à v1.4.0) voit cette version comme identique ou plus ancienne, et la mise à jour automatique ne fait pas ce saut seule. Lancez une fois :

```bash
sudo edge-setup upgrade --yes --allow-downgrade --release-url https://releases.openedbot.app/edge-setup
```

Les mises à jour suivantes reprennent le geste habituel : `sudo edge-setup upgrade --yes`.

## v0.0.5 - 2026-11-03

### Sécurité

- Avec `--ssh-hardening`, le compte d'administration `hermes-admin` doit désormais taper son propre mot de passe pour chaque `sudo` : une clé SSH volée ne suffit plus à devenir root. `edge-setup up` demande ce mot de passe deux fois sans l'afficher, ou en génère un, l'affiche une seule fois et attend que vous confirmiez l'avoir rangé, avant de rien changer. Il doit compter au moins 14 caractères. Il n'est jamais écrit dans un journal ni affiché ailleurs que sur votre terminal, et il n'est posé qu'une fois prouvé que SSH refuse les mots de passe.
- `--admin-sudo=nopasswd` garde l'ancienne règle, sans mot de passe. Une machine déjà durcie garde la sienne. `edge-setup audit` signale une règle sans mot de passe là où un mot de passe a été choisi.

### Ajouté

- `--admin-sudo password|nopasswd` choisit la règle sudo de `hermes-admin` (`password` par défaut).
- `--admin-password-file` lit ce mot de passe dans un fichier réservé à son propriétaire, pour une installation sans terminal.
- Le connecteur prévient openedbot dès que les outils, les serveurs MCP ou les compétences de la machine changent, y compris quand le changement est fait directement sur la machine. La page des connecteurs s'ouvre alors déjà à jour, sans attendre la machine. Le connecteur ne lit que les noms et les dates des fichiers concernés, jamais leur contenu.
- Une image ou un PDF qu'un bot fabrique pour vous s'affiche désormais dans la conversation, prêt à être ouvert ou téléchargé. Le connecteur ne lit que le fichier que le bot désigne dans son espace de travail, et seulement s'il s'agit vraiment d'une image ou d'un PDF de 1 Mo au plus : un raccourci vers un autre endroit de la machine, un dossier ou tout autre fichier est refusé.
- Un nouveau bot est prêt près de trois fois plus vite (de 25 s à moins de 10 s sur une petite machine). Ses outils sont réglés en une seule écriture, au lieu d'un par un. Ses compétences intégrées sont réglées pendant la création même du bot. La liste des outils disponibles n'est plus relue à chaque nouveau bot.

### Corrigé

- La page des compétences d'openedbot affichait « Hermes n'a pas pu lister ses skills » avec les versions récentes de Hermes, à cause d'un défaut de Hermes lui-même. Le connecteur lit désormais la liste directement sur la machine quand Hermes échoue.
- Avec `--password-policy`, un changement de mot de passe pouvait échouer faute du dictionnaire de mots de passe : edge-setup installe désormais `cracklib-runtime` avec la politique.

## v0.0.4 - 2026-11-01

### Sécurité

- La signature d'une release n'est acceptée que si elle vient de la chaîne de publication d'openedbot lancée sur le tag de cette version précise, comparé à l'identique : une signature faite pour une autre version, ou pour un tag qui commence pareil, est refusée. L'installation, `edge-setup upgrade`, la mise à jour automatique et `edge-setup self-verify` appliquent cette règle, et `self-verify` vérifie la release de la version installée, et non plus la dernière publiée.
- Le binaire téléchargé doit annoncer la version pour laquelle ses empreintes sont signées ; sinon rien n'est installé.
- Une mise à jour n'installe qu'une version strictement plus récente que celle en place : la même version ou une plus ancienne est refusée. `edge-setup upgrade --allow-downgrade` permet de la réinstaller ou de revenir en arrière, toujours avec une release signée pour sa propre version : une version non signée reste refusée. La mise à jour automatique ne revient jamais en arrière.
- Le script d'installation refuse toute valeur de `--version` qui n'est pas exactement `vX.Y.Z`. Une valeur écrite avec un échappement (par exemple `v0.0.\061`) passait la vérification sous la forme `v0.0.1` alors que la valeur brute servait ensuite au téléchargement et à la vérification de la signature.

### Corrigé

- Quand une mise à jour ne prouve pas que la nouvelle version fonctionne et que l'ancienne est remise en place, edge-setup l'annonce désormais comme un retour arrière (`rolled back edge-setup vX -> vY`) et non plus comme une mise à jour (`upgraded`). Le message vient de la version remise en place : il apparaît pour les retours vers la v0.0.4 et les versions suivantes.

### À savoir

- Le retour automatique à l'ancienne version lors d'une mise à jour manuelle est apparu en v0.0.3 : c'est la version en place qui conduit la mise à jour. Une machine encore en v0.0.2 qui passe directement en v0.0.4 n'a donc pas ce filet ; elle se met à jour comme d'habitude avec `sudo edge-setup upgrade --yes`.

### Provenance

- La release v0.0.4 publiée sur `releases.openedbot.app` et signée par le workflow `edge-setup-release.yml` a été construite depuis le commit `1cf8763` du dépôt d'origine, avant la réinitialisation de l'historique. Les empreintes SHA-256 des artefacts sont dans `SHA256SUMS`, publié avec la release sur R2 (`edge-setup/v0.0.4/SHA256SUMS`).

## v0.0.3 - 2026-11-01

### Sécurité

- Les releases sont désormais signées par la chaîne de publication d'openedbot, sans clé à garder (Sigstore), et chaque signature est inscrite dans un journal public. L'installation, la mise à jour, la mise à jour automatique et `edge-setup self-verify` vérifient cette signature, puis l'empreinte du binaire, avant d'installer ou d'exécuter quoi que ce soit : une version qui ne vient pas de cette chaîne est refusée et rien ne change sur votre machine.
- Le script d'installation installe la version avec laquelle il est publié, jamais une dernière version implicite : `--version` permet d'en choisir une autre, `--version latest` la plus récente. `--dry-run` fait toutes les vérifications et montre l'étape d'installation sans rien écrire.
- `edge-setup uninstall` demande désormais à openedbot de révoquer le runtime de chaque lien avant de l'effacer, avec une preuve faite par la clé de l'appareil : la machine désinstallée ne laisse plus d'identité active derrière elle. `edge-setup unlink` fait de même pour un lien. Si openedbot ne confirme pas (hors ligne, ou plus ancien), la commande le dit, indique où révoquer à la main, et continue.
- `edge-setup up`, `upgrade`, `uninstall` et `reset` acceptent `--dry-run` : tout ce qui serait fait est montré, rien n'est écrit.
- Si une mise à jour manuelle (`edge-setup upgrade`) ne prouve pas que la nouvelle version fonctionne, l'ancienne est remise en place automatiquement, comme le faisait déjà la mise à jour automatique.
- Lancé depuis un shell ou un conteneur sans masque de permissions (umask 0), edge-setup ne crée plus de répertoires ni de fichiers modifiables par tous : il retire toujours le droit d'écriture du groupe et des autres utilisateurs, quel que soit l'umask hérité.
- Sur une première installation, le fichier de configuration du runtime était laissé lisible par les autres utilisateurs de la machine : il est désormais réservé au compte du runtime dès la fin de `up`.
- Avec `--firewall`, le service qui réserve les ports locaux du runtime à son compte et à root est désormais confiné (ni réseau, ni périphérique, ni appel système privilégié) ; une mise à jour l'applique aux machines déjà installées.
- Les commandes qui modifient la machine tiennent un journal privé, lisible par root seulement, qui masque tout ce qui ressemble à un secret.
- Les versions publiées avant celle-ci ne sont pas signées : une fois à jour, votre machine ne les installe plus. Une machine en v0.0.2 se met à jour comme d'habitude avec `sudo edge-setup upgrade --yes`.

### Ajouté

- openedbot peut connecter un serveur MCP à un bot précis : l'autorisation OAuth se fait pour le profil du bot, et le jeton est rangé dans ce profil, le seul que ses conversations lisent. Une autorisation faite à la racine du runtime ne servait pas aux bots. Nouvelle capacité annoncée : `mcp_oauth_profile`.
- openedbot peut déconnecter un serveur MCP d'un bot précis : le serveur quitte la configuration du profil du bot et son jeton OAuth est supprimé du profil ; les autres bots et la racine ne changent pas. Nouvelle capacité annoncée : `mcp_profile_disconnect`.
- Plus de redémarrage du gateway après un changement MCP quand le Hermes installé recharge ses serveurs MCP tout seul (toutes les 60 s, et entre deux tours d'une conversation ouverte) : connecter, déconnecter, autoriser ou basculer un serveur MCP ne marque plus le gateway « à redémarrer ». Un Hermes plus ancien garde le comportement précédent. Nouvelle capacité annoncée : `mcp_live_reload`.
- Redémarrer le gateway depuis openedbot ne coupe plus les conversations en cours : elles se terminent d'abord, les nouveaux messages attendent quelques secondes la relance, puis repartent seuls. Nouvelle capacité annoncée : `gateway_graceful_restart`.
- Retirer un serveur MCP de la racine supprime aussi son jeton OAuth, comme `hermes mcp remove` : il restait sur le disque sans que rien ne l'affiche. La réponse dit si un fichier de jeton a survécu.
- Un serveur MCP ajouté sans jeton, puis autorisé, est désormais activé par l'autorisation au lieu de rester désactivé.

### Modifié

- Sans `--openedbot`, `edge-setup link` relie désormais l'hôte à l'origine de production `https://link.openedbot.app` ; une autre origine reste possible avec `--openedbot`.
- Les messages, l'aide et la documentation nomment désormais le produit openedbot. La commande s'appelle `edge-setup` ; un ancien alias `hermes-setup` déjà présent sur une machine reste mis à jour, mais les nouvelles installations n'en posent plus.
- Les releases ne publient plus de copies des binaires sous l'ancien nom : la mise à jour automatique des versions publiées utilise déjà le nom `edge-setup`.

## v0.0.2 - 2026-10-27

### Corrigé

- Après un redémarrage de la machine, les outils qui s'exécutent dans le bac à sable de Docker pouvaient échouer jusqu'à un redémarrage manuel du runtime : il démarrait parfois une seconde avant Docker. Le runtime attend désormais que Docker soit prêt, une minute au plus, puis démarre dans tous les cas.

### Mettre à jour

```bash
sudo edge-setup upgrade --yes
```

La correction s'applique à la mise à jour, sans autre geste.

## v0.0.1 - 2026-10-26

### Nouvelle origine de téléchargement

- edge-setup se télécharge et se met à jour depuis `releases.openedbot.app`. L'ancienne adresse de téléchargement n'est plus utilisée, ni par l'installation ni par la mise à jour.
- Si cette adresse ne répond pas ou ne sert pas une version vérifiable, l'installation et la mise à jour s'arrêtent sans rien modifier sur votre machine.

### Sécurité

- Le binaire est construit avec la dernière version corrective de Go, qui corrige une faille de vérification des certificats.

### Passer d'une ancienne version (v1.x) à celle-ci

La numérotation repart de zéro : votre machine voit cette version comme plus ancienne et la refuse par défaut, et la mise à jour automatique ne fait pas ce saut seule. Lancez une fois :

```bash
sudo edge-setup upgrade --yes --allow-downgrade --release-url https://releases.openedbot.app/edge-setup
```

Les mises à jour suivantes reprennent le geste habituel : `sudo edge-setup upgrade --yes`.

## v1.4.0 - 2026-10-23

### Bots plus légers et plus rapides

- Vos bots répondent plus vite, surtout au premier message après une pause : chaque bot démarre avec un jeu de capacités resserré (recherche web, terminal et apprentissage de skills), au lieu de tout ce que Hermes sait faire.
- Les skills livrées avec Hermes sont désormais coupées d'un coup sur chaque bot. Celles que votre bot a apprises et celles que vous avez installées depuis la Marketplace restent actives.
- Attention : à la mise à jour, les capacités de chacun de vos bots existants sont remises à ce socle, une fois. Vous réactivez ce dont un bot a besoin dans ses réglages, rubrique Capacités.

Mise à jour : `sudo edge-setup upgrade --yes`.

## v1.3.0 - 2026-10-23

### Modèles et fournisseurs

- Changer le modèle de tous vos bots est plus rapide : votre machine met à jour leurs profils en une seule fois, au lieu d'un bot après l'autre.
- La console vous prévient quand le connecteur d'un fournisseur n'est pas installé sur votre machine, avant qu'un échange avec un bot n'échoue.
- `edge-setup upgrade` vous indique quand relancer `sudo edge-setup up --yes` pour installer un connecteur de fournisseur manquant.

### Approbations

- Le mode manuel d'un bot est désormais appliqué par votre machine elle-même : une action qui modifie quelque chose attend votre accord, quel que soit le modèle utilisé.

Mise à jour : `sudo edge-setup upgrade --yes`, puis `sudo edge-setup up --yes` pour installer les connecteurs de fournisseurs.

## v1.2.2 - 2026-10-21

### Rapidité

- Les réglages de la console s'ouvrent plus vite : votre machine répond avec ses dernières informations connues et les rafraîchit en arrière-plan.
- Plusieurs écrans ouverts en même temps ne font plus travailler votre machine plusieurs fois pour la même information.
- La recherche de skills n'attend plus la mise à jour du catalogue.

### Fiabilité

- Une liaison vers une console de développement locale qui ne répond plus s'arrête au bout d'une minute, au lieu de réessayer sans fin.

Mise à jour : `sudo edge-setup upgrade --yes`

## v1.2.1 - 2026-10-21

### Hub de skills

- La recherche de skills répond vite, même juste après une installation ou après une longue période sans usage : le catalogue est préparé à l'avance sur votre machine.
- Les skills publiées depuis GitHub apparaissent désormais dans les résultats.

Mise à jour : `sudo edge-setup upgrade --yes`

## v1.2.0 - 2026-10-21

### Hermes 0.22.2 et hub de skills

- Les nouvelles installations utilisent Hermes 0.22.2, avec le hub de skills disponible depuis la console.
- La commande `edge-setup upgrade` reste compatible avec cette version du runtime.
- Pour déplacer un runtime existant vers Hermes 0.22.2, lancez `sudo edge-setup up --yes`.

### Fiabilité

- Supprimer un bot libère désormais entièrement son profil sur votre machine.
- La création d'un bot qui échoue ne laisse plus de profil à moitié créé.

Mise à jour : `sudo edge-setup upgrade --yes`, puis `sudo edge-setup up --yes` pour passer le runtime en Hermes 0.22.2.

## v1.1.0 - 2026-10-21

### Installer des skills depuis le hub Hermes

- Depuis la console, recherchez une skill dans le hub Hermes, lisez sa fiche, puis installez-la sur un bot en un clic.
- Seules les skills de provenance officielle ou vérifiée s'installent, et chacune passe d'abord une analyse de sécurité.
- Le hub demande une version récente de Hermes sur votre machine. Avec une version plus ancienne, rien ne change.

### Fiabilité

- Une installation en cours n'est plus perdue quand le service redémarre.

Mise à jour : `sudo edge-setup upgrade --yes`

## v1.0.0 (ancien dépôt) - 2026-10-17

### Première version stable, alignée sur openedbot 1.0

- Même code que v0.5.11 : le connecteur passe en 1.0.0 avec openedbot 1.0.0,
  qui termine l'alpha privée et la bêta. Aucun changement de protocole ni
  de commande ; `edge-setup upgrade` monte depuis toute v0.5.x.

## v0.5.11 - 2026-10-17

### Le gateway attend le dockerd rootless au démarrage

- `hermes-gateway.service` est ordonné après `user@<uid>.service` (et le
  réclame) quand Docker est activé. Au démarrage de la machine, l'unité
  système partait avant le gestionnaire de l'utilisateur de service : le
  montage de `docker.sock` était sauté (son `-` de tête), et chaque
  `execute_code` échouait en « docker version failed » jusqu'à un
  redémarrage du gateway à la main. Constaté sur un hôte de production le
  2026-10-17, réparé sur place par un redémarrage du gateway depuis la
  console.

## v0.5.10 - 2026-10-13

### `model-context` mesure le préambule du gateway

- `GET /hermes-setup/model-context` porte un champ `preamble` : ce que le
  gateway place devant chaque run, poste par poste. L'identité (`SOUL.md`),
  la mémoire intégrée (`MEMORY.md`, `USER.md`, selon les drapeaux du profil),
  l'index des skills actives (nom et description du front matter), les
  schémas d'outils de la plateforme `api_server` (par
  `model_tools.get_tool_definitions`) et les serveurs MCP qu'elle porte. La
  console s'en sert pour ventiler la fenêtre de contexte : sans lui, sa jauge
  ne voyait que ce qu'openedbot envoie et restait un plancher.
- Seuls des tailles (quatre caractères par jeton, comme l'amont) et des noms
  sortent de la sonde : jamais une ligne de SOUL, une entrée de mémoire, un
  corps de skill, un schéma, un chemin ni une valeur d'environnement. La route
  revérifie la forme (postes connus, ordre fixe, 64 membres, noms bornés).
- Un poste qui ne se mesure pas est publié `tokens: null`, jamais `0`. C'est
  toujours le cas des serveurs MCP : leurs schémas ne sont connus qu'une fois
  le gateway connecté, et la sonde n'ouvre aucune connexion. L'import de
  `model_tools` se fait sous un `HERMES_HOME` vide pour cette raison.
- Une sonde plus ancienne n'envoie pas le champ : la route ne l'invente pas.

## v0.5.9 - 2026-10-12

### Le marqueur « redémarrage en attente » survit au redémarrage de l'opérateur

- `hermes-operator.service` déclarait `RuntimeDirectory=hermes-operator` sans
  `RuntimeDirectoryPreserve=yes` : systemd supprimait `/run/hermes-operator` à
  chaque arrêt ou redémarrage de l'opérateur, et avec lui le marqueur
  `gateway-restart-pending`. `upgrade` redémarre toujours l'opérateur : un
  redémarrage du gateway en attente (écriture MCP, identifiants A2A, capacités
  de profil, directives de l'unité gateway changées pendant des runs)
  disparaissait, et la console cessait de dire que le gateway doit redémarrer.
  L'unité porte maintenant `RuntimeDirectoryPreserve=yes` : seul un
  redémarrage de la machine vide `/run`, et le gateway redémarre alors de
  toute façon.
- Un hôte déjà installé reçoit l'unité avec `upgrade` (mise à jour automatique
  comprise) ou `up` : elle est réécrite et rechargée avant le redémarrage de
  l'opérateur, donc un marqueur déjà posé survit aussi à ce redémarrage-là.
- `reset` et `uninstall` retirent `/run/hermes-operator` (socket et marqueur
  compris) : l'unité ne vide plus ce répertoire à son arrêt, et il aurait
  survécu à la désinstallation jusqu'au prochain redémarrage de la machine. Le
  plan l'affiche avec les fichiers du runtime, et le contrôle de résidu le
  compte.

### Le pare-feu UFW garde le DNS d'un résolveur des plages de métadonnées

- `--firewall` refusait `169.254.0.0/16` et `fd00:ec2::/64` pour tout l'hôte
  (`deny out`). Quand le résolveur est dans ces plages (GCE et OCI servent le
  DNS sur `169.254.169.254`), le refus coupait le DNS de l'hôte, requêtes amont
  de systemd-resolved comprises : contrairement aux unités, le stub
  `127.0.0.53` n'abrite de rien, UFW filtre aussi le démon.
- `up` lit `/etc/resolv.conf` et `/run/systemd/resolve/resolv.conf` (les amonts
  du stub). Pour chaque résolveur situé dans ces plages, il pose
  `ufw prepend allow out to <ip> port 53 proto udp`, puis `tcp`, avant le
  `deny out` de la plage (commentaire `Hermes-managed`, donc retiré avec les
  autres par le rollback et `reset`). `prepend` place la règle au-dessus de
  toutes les autres de sa famille, un refus déjà posé compris. Seul le port 53
  de cette adresse passe : le reste, métadonnées HTTP comprises, reste refusé.
  Sans résolveur dans ces plages, les règles posées sont celles d'avant.
- Avant tout instantané, `up` refuse le pare-feu si un fichier de résolveur
  existe sans pouvoir être lu, ou si `ufw --dry-run` refuse la règle (UFW sans
  IPv6 pour un résolveur `fd00:ec2::/64`, par exemple) : il ne coupe pas le DNS
  pour voir. Si l'exception ne peut pas être ajoutée pendant `up`, le refus de
  sa plage ne l'est pas non plus.
- La preuve finale exige chaque exception au-dessus du refus de sa plage. Un
  pare-feu posé par une version antérieure (le refus, sans l'exception) la
  reçoit sans intervention : `up --yes` et `verify-access` la préposent puis
  relisent l'ordre, et `upgrade` aussi (un échec n'y est qu'un avertissement).
  La preuve n'échoue que si ce rétablissement échoue. UFW ne déplace pas une
  règle qu'il possède déjà : si l'exception figure sous le refus, le message
  donne la commande `ufw delete` à passer.
- Un refus de `up` avant l'armement du rollback ne bloque plus l'`up` suivant.
  Il laissait les instantanés (`ufw.was-*`, `fail2ban.was-*`, `ssh-dropin.*`,
  copies des fichiers UFW et du compte cloud) que `ResetAfterRollback` refuse
  (« incomplete pre-arm hardening state; manual recovery is required »). Les
  instantanés pris par la tentative refusée sont retirés, sauf si elle a aussi
  laissé la trace d'une modification faite (compte, drop-in, minuterie) : l'état
  reste alors pour la reprise manuelle.
- `reset` et `uninstall`, sans sauvegarde des fichiers UFW, listaient les règles
  `Hermes-managed` après avoir désactivé UFW, qui n'affiche plus alors aucune
  règle : rien n'était supprimé. Elles sont listées et supprimées pendant
  qu'UFW est actif, puis UFW est désactivé (et réactivé s'il l'était).

### `upgrade` apporte aussi l'unité gateway

- Seul `up` écrivait `hermes-gateway.service` : un correctif de l'unité
  (`InaccessiblePaths=-/run/credentials`, `ExecStartPre=+/bin/mkdir`, le refus
  des métadonnées sans `IPAddressAllow=any`, l'exception du résolveur
  link-local) n'atteignait jamais un hôte installé tant que l'opérateur ne
  relançait pas `edge-setup up --yes`. `upgrade` et `upgrade --auto` rendent
  maintenant l'unité avec les paramètres exacts de `up` (variante sandbox lue
  dans l'état, uid du compte `hermes`, résolveurs de `/etc/resolv.conf`, par
  le même code) et la comparent au fichier installé. Ils n'en créent jamais
  une, et ne devinent aucun paramètre : sans état ou sans compte `hermes`,
  l'unité est laissée telle quelle et le message renvoie à `up --yes`.
- Unité identique : rien n'est écrit, rien ne redémarre. Unité différente :
  écriture atomique, `daemon-reload`, puis :
  - hôte au repos (aucune transaction active, aucun run en cours dans le
    journal du connecteur : le signal que la mise à jour automatique utilise
    déjà) : `hermes-gateway` redémarre et `/health` est prouvé ;
  - sinon : le gateway n'est pas touché, le marqueur « redémarrage en
    attente » des écritures MCP est posé, la console l'affiche et le
    propriétaire redémarre avec le verbe existant
    `POST /hermes-setup/gateway/restart`, ou avec
    `systemctl restart hermes-gateway`. `upgrade` dit lequel des deux
    chemins il a pris ;
  - si `/health` ne répond pas après le redémarrage, ou si le marqueur ne peut
    pas être posé, l'unité précédente est remise en place, rechargée, le
    gateway redémarré dessus dans le premier cas, et l'étape `upgrade` sort en
    échec (avec `--auto`, le binaire précédent est remis aussi).
- Une unité qui ne diffère que par des commentaires (une ligne dont le premier
  caractère non blanc est `#` ou `;`) ou des lignes vides ne change rien pour
  systemd : elle est réécrite de façon atomique et rechargée (`daemon-reload`,
  pour que `systemctl` ne la signale pas modifiée sur disque), mais le gateway
  n'est pas redémarré, même au repos, et le marqueur « redémarrage en attente »
  n'est pas posé. `upgrade` le dit dans sa sortie (« comment-only »). Une
  version qui reformule seulement un commentaire du gabarit ne redémarre donc
  plus le gateway de tout le parc en mise à jour automatique. Un `#` au milieu
  d'une valeur n'est pas un commentaire, et une directive commentée, retirée ou
  modifiée reste une différence : le chemin ci-dessus s'applique alors, sans
  changement. `up` garde sa règle : il réécrit et redémarre sur toute différence
  de texte, commentaires compris, car c'est un geste explicite de l'opérateur.
- `audit` ajoute `hermes_gateway_unit` : un avertissement, avec son remède
  (`sudo edge-setup upgrade --yes` ou `sudo edge-setup up --yes`), tant que
  l'unité installée diffère de celle que le binaire rend. `doctor` l'avertit
  aussi. Les remèdes de `cloud_metadata_egress` nomment maintenant `upgrade`
  avant `up`.

### Le `hello` ne dépasse plus la borne de l'API

- Un hôte complet (A2A et audit de création) annonçait déjà 16 noms, la borne
  de toute API : la feature suivante aurait rendu le `hello` de chaque hôte à
  jour refusé 4401, que le connecteur compte comme un refus d'authentification
  (dix de suite, puis un essai toutes les 30 minutes). Le connecteur coupait la
  liste de l'opérateur à 16 avant d'y joindre `creation_audit_v2`, donc au-delà
  de la borne.
- L'API accepte maintenant 64 noms dans `hello` et `capabilities`, et annonce
  cette borne dans `link.context` (`limits.features`). Un hôte plus ancien
  ignore le champ, comme `latestVersion` et `minimumVersion`.
- Le connecteur ne liste jamais plus de noms que la borne en vigueur : 16 tant
  qu'aucune n'est annoncée, puis la dernière annoncée, persistée dans
  `link-context.json` et appliquée dès le `hello` suivant. Les noms sont
  classés par priorité fixe (features du lien d'abord, puis l'opérateur), les
  noms retirés sont journalisés, et `capabilities` suit la même borne.
- Un `hello` de plus de 16 noms refusé 4401 avant toute trame ramène la borne
  à 16 : une API revenue en arrière ne remet pas le lien en boucle de refus.
- Ordre de déploiement : l'API d'abord, les hôtes ensuite
  (`docs/CONNECTOR.md`, « Borne des features »).

### Le refus des métadonnées cloud s'applique enfin dans les unités

- Les unités `hermes-gateway`, `hermes-connector` et `hermes-operator`
  rendaient `IPAddressAllow=any` devant `IPAddressDeny=169.254.0.0/16` et
  `IPAddressDeny=fd00:ec2::/64`. systemd évalue d'abord `IPAddressAllow=`
  (`systemd.resource-control(5)`) : toute adresse correspondait à `any`, le
  refus ne s'appliquait jamais, et un code d'agent lancé par le gateway
  (backend de terminal `local`) pouvait joindre `169.254.169.254`. Les
  gabarits ne rendent plus `IPAddressAllow` : ces deux plages sont refusées,
  tout le reste passe, loopback compris.
- Un hôte déjà installé reçoit les trois unités avec `upgrade` (mise à jour
  automatique comprise ; le gateway suit les règles de la section ci-dessus :
  redémarré si l'hôte est au repos, sinon en attente). Tant que l'unité
  gateway n'est pas réécrite, `audit` échoue sur `cloud_metadata_egress` : il
  lit maintenant `IPAddressAllow` en plus de `IPAddressDeny`.
- Exception pour le DNS : quand `/etc/resolv.conf` nomme un résolveur situé
  dans ces plages (GCE et OCI servent le DNS sur `169.254.169.254`, l'adresse
  des métadonnées), `up`, `upgrade` et `link --rekey` autorisent cette seule
  adresse (`IPAddressAllow=<adresse>/32`) dans les trois unités et le disent
  au journal. Sans elle, l'hôte perdrait le DNS et le connector son lien dès
  que le refus s'applique. Les métadonnées restent joignables par cette
  adresse : `audit` le signale en avertissement, et le stub de
  systemd-resolved (`127.0.0.53`) n'a besoin d'aucune exception. Un
  `IPAddressAllow` qui recouvre ces plages sans être un résolveur reste un
  échec de `audit`.
- Le filtre exige le BPF cgroup : sans lui (noyau ou gestionnaire de
  conteneur, par exemple un conteneur LXC non privilégié), systemd ignore
  `IPAddressDeny` sans erreur.

### `reset` retire le garde loopback

- `reset` et `uninstall` arrêtent, désactivent et suppriment
  `hermes-loopback-guard.service`, et suppriment ses règles iptables `OUTPUT`
  (ports 8642 et 9119). Avant, l'unité restait active et le contrôle des
  résidus échouait.

### `uninstall` désinstalle edge-setup d'un serveur

- `edge-setup uninstall --yes` retire le runtime comme `reset` et demande au
  terminal s'il faut garder ou purger les données (bearer, credentials,
  workspaces). Purger exige de taper `purge` ; toute autre réponse annule sans
  rien modifier. Hors terminal, `--keep-data` ou
  `--purge-data --i-understand-data-loss` est requis.
- `reset` et `uninstall` retirent aussi `edge-setup` et `hermes-setup` de
  `/usr/local/bin`, `/usr/local/sbin` et `/usr/sbin`, que `reset` laissait en
  liens cassés. Un fichier du paquet `.deb` est gardé pour
  `apt remove edge-setup`, et le contrôle des résidus vérifie ces chemins.

### Les releases se publient seules, sans jeton personnel

- `MakFly/edge-setup-releases` publie lui-même ses releases : son workflow
  `publish.yml` liste toutes les 10 minutes les tags `vX.Y.Z` du dépôt source
  par une deploy key en lecture seule, garde ceux au-dessus de sa dernière
  release, rejoue `make test`, `make test-release`, `make build-all` et
  `sha256sum -c` sur chaque tag, puis crée la release (les 9 mêmes fichiers,
  les mêmes notes) avec son propre `GITHUB_TOKEN`. Rejouer est sans effet sur
  une release existante.
- `edge-setup-release.yml` ne fait plus que vérifier le tag (contrat et
  build) et annonce la publication par le dépôt de releases. `RELEASES_TOKEN`
  n'est plus attendu.
- `make publish VERSION=vX.Y.Z` reste le repli manuel depuis l'arbre propre
  du tag.

## v0.5.8 - 2026-10-06

### L'hôte propose sa mise à jour automatique au lieu de la taire

- `doctor` avertit tant que `hermes-setup-upgrade.timer` est désactivé et
  nomme la commande exacte : `sudo edge-setup auto-upgrade enable --yes`.
  Mesuré le 2026-10-06 : un hôte client tourne encore en v0.5.3 alors que
  v0.5.7 est publiée, parce que rien ne lui proposait le timer. L'avertissement
  ne change pas le code de sortie et `doctor` reste hors ligne : il ne lit
  que systemd.
- Un `up` ou un `link` réussi se termine par une ligne `hint` qui recommande
  la même commande quand le timer est désactivé. Rien n'est activé en
  silence.
- `up --auto-upgrade --yes` active le timer à la fin d'une installation
  réussie, comme `auto-upgrade enable --yes`. L'option ne touche à aucun
  accès et n'est pas enregistrée dans l'état ; elle est refusée sur macOS.
- `doctor` ne compare pas la version installée à la dernière release :
  aucune source locale ne la connaît sans réseau.

## v0.5.7 - 2026-10-06

### Le lien suit OpenHermesBot quand il change de nom sous son domaine

- Quand `link.context` annonce une origine `https://` dont l'hôte est un
  sous-domaine (ou le parent) de celui que le connecteur compose, le
  connecteur l'écrit dans `link-origin.json`, ferme la session et se
  reconnecte dessus, avec le même runtime, le même jeton et la même clé.
  Mesuré le 2026-10-06 : la prod est passée de `console.openedbot.app` à
  `openedbot.app` ; sans ce changement, chaque hôte devait recevoir un
  nouveau ticket, et `link --replace` créait un nouveau runtime en laissant
  les bots sur l'ancien. Un lien de développement (`ws://`), un autre
  domaine ou une adresse IP ne déplacent jamais rien, et trois sessions
  non confirmées sur la nouvelle origine ramènent à l'ancienne.

## v0.5.6 - 2026-10-06

### Le lien de développement revient en deux secondes

- Quand l'origine OpenHermesBot est la loopback de l'hôte (le tunnel de
  `make link-dev-up`) et que le dial est refusé, le connecteur ne monte plus
  son délai de reconnexion jusqu'à 60 s : il reste à 2 s
  (`LoopbackRefusedBackoff`). Un refus sur la loopback ne coûte rien et dit
  seulement que le tunnel est tombé. Mesuré le 2026-10-06 sur le runtime du lab :
  au plafond de 60 s, le lien revenait 33 s après la réouverture du tunnel ;
  avec le plafond court, 2 s. Une origine publique garde le backoff d'incident
  complet.

## v0.5.5 - 2026-10-05

### Le profil renforcé complet passe sur une VM cloud Debian 13 vierge

- P4 charge `nf_tables` (`modprobe`) et le rend persistant dans
  `/etc/modules-load.d/hermes-docker.conf` avant
  `dockerd-rootless-setuptool.sh`, qui refusait de continuer sur le noyau
  cloud. Un échec de `modprobe` est affiché tel quel ; dans un LXC, le message
  renvoie au chargement sur l'hôte Proxmox. `reset` retire le fichier.
- `/home/hermes/.config` n'est plus créé par root : P4 le crée (ou le rend)
  à `hermes`, sinon l'outil rootless ne pouvait pas y écrire
  `systemd/user`.
- Les quatre paquets Docker épinglés sont mis en `hold` dès leur installation,
  et P7 les tient avant son `apt-get upgrade`. Avant, P7 montait Docker
  au-delà de l'épingle, et la reprise suivante échouait en P4 sur le
  downgrade. Une montée d'épingle passe toujours ;
  `reset --purge-packages` lève le `hold` avant la purge.
- La reprise après le reboot exigé par les mises à jour de P7 n'est plus
  refusée (« unexpected artifact at reboot checkpoint ») : les marqueurs de
  propriété de la configuration unattended-upgrades écrits avant ce reboot
  sont acceptés, y compris par un checkpoint écrit par une version antérieure.

### `up` ne laisse plus jamais le gateway à terre

- Quand une étape échoue après que la passe a arrêté le gateway (coupure
  PyPI pendant `uv sync`, `git` injoignable, interruption), `up` le redémarre
  avant de rendre l'erreur, à la seule condition que l'installation se prouve
  encore (`hermes --version`). Une installation à moitié écrite reste arrêtée,
  volontairement, et la raison est affichée.
- L'unité `hermes-gateway` porte `StartLimitIntervalSec=600` et
  `StartLimitBurst=10` : une boucle de redémarrage toutes les 3 secondes
  s'arrête au bout de dix tentatives au lieu de brûler le VPS et de noyer la
  cause dans le journal.

### Le checkout Hermes se répare au lieu de bloquer l'installation

- Les artefacts de construction laissés par le runtime dans le checkout
  (`node_modules` d'un bridge WhatsApp ou Photon installé par un
  `sudo hermes whatsapp`, `hermes_agent.egg-info`) sont rendus à root avant la
  preuve de propriété, qui est ensuite rejouée. Avant, l'installation
  s'arrêtait sur `hermes code writable outside root`, et l'hôte ne pouvait
  plus recevoir aucun correctif, puisque seul `up` touche au checkout.
- Les sondes d'écriture du runtime (`scripts/whatsapp-bridge/.write_test`,
  `plugins/platforms/photon/sidecar/.hermes-write-probe`,
  `.photon-npm-error.log`) sont retirées avant la lecture de `git status` :
  un fichier vide laissé par un arrêt brutal ne coûte plus un arrêt du
  gateway et une réinitialisation du checkout.
- Rien n'est supprimé en silence : tout ce qui sort du checkout, sondes
  comprises, et tout fichier non suivi qu'un `git clean -ffd` allait effacer
  (par exemple un plugin déposé par le client) est conservé dans
  `/var/lib/hermes-setup/quarantine/<horodatage>/`, avec le `git status`
  correspondant.

### Un hôte bloqué se répare, et une release rejetée n'est plus condamnée

- `upgrade` réconcilie le checkout Hermes (sondes mises en quarantaine,
  artefacts rendus à root, invariant reprouvé), hors ligne et sans arrêter
  quoi que ce soit. Jusqu'ici seul `up` touchait au checkout : un hôte que
  `up` refusait ne pouvait donc jamais recevoir le correctif de la raison
  même de ce refus. L'échec de cette réconciliation est signalé, jamais
  transformé en échec de mise à jour.
- Un `config.yaml` ou un `runtime.env` qu'un `sudo hermes config set` ou un
  éditeur a laissé en 0644, ou possédé par root, est remis en 0600 et rendu à
  l'utilisateur de service, puis exigé. Avant, ce mode faisait échouer `up`,
  chaque `upgrade` ET le retour arrière de cet upgrade : l'hôte était dans une
  impasse permanente pour un droit que personne n'avait voulu changer.
- Une release rejetée par une passe automatique est laissée de côté 24 heures,
  puis réessayée une fois, au lieu d'être écartée définitivement. Un disque
  plein dix secondes, une coupure réseau pendant la preuve du lien ou un
  délai systemd suffisaient à condamner une release saine pour toujours, la
  marque n'étant effacée que par une mise à jour réussie. Un enregistrement
  écrit par une version antérieure est horodaté à la volée.

### Les bridges Node des plateformes sont prêts avant d'être utilisés

- Node 22 LTS épinglé et vérifié par SHA-256 est installé dans
  `/usr/local/lib/hermes-node`, possédé par root, et publié sur le PATH
  (`node`, `npm`, `npx`). Sans Node sur le PATH, l'adaptateur WhatsApp refuse
  de démarrer et le runtime va chercher lui-même une archive sur nodejs.org
  qu'il installe sous HERMES_HOME : l'interpréteur exécuté par le gateway
  vivait alors dans un répertoire que le gateway peut réécrire.
- Les bridges WhatsApp et Photon sont recopiés dans HERMES_HOME, où
  l'utilisateur de service peut écrire, et leurs dépendances y sont installées
  par `npm ci` avant tout usage. Deux défauts amont sont corrigés au passage :
  la copie WhatsApp n'était faite qu'une fois et jamais rafraîchie, donc une
  montée de version de Hermes laissait un vieux bridge face à un adaptateur
  neuf ; la copie Photon ne listait que quatre fichiers et en oubliait deux
  que son point d'entrée importe. La copie est comparée par contenu, et
  `node_modules` n'est jamais recopié.
- Toute cette phase est au-delà du chemin critique : elle tourne après le
  démarrage du gateway et ses échecs sont rapportés, jamais transformés en
  échec d'installation. Un registre npm ou un nodejs.org injoignable coûte une
  plateforme, jamais une installation.
- `download.Fetch` répond désormais une erreur au lieu de planter quand aucun
  client HTTP n'est configuré.

## v0.5.4 - 2026-09-16

### Lien connecteur et checkout Hermes stabilisés

- La preuve de propriété du checkout ignore les liens symboliques que npm
  crée dans `node_modules/.bin` : leur mode `lstat` vaut 0777 sans que la
  cible soit inscriptible.

### Renommage en `edge-setup`

- Le module et le binaire s'appellent `edge-setup` (module Go
  `github.com/MakFly/edge-setup`, `cmd/edge-setup`). Compatibilité d'un hôte
  déjà provisionné : `hermes-setup` reste un alias symlink vers le même
  binaire, créé et rafraîchi par `install` et chaque `upgrade`, dans
  `/usr/local/lib/hermes-setup/` et dans chaque copie PATH existante
  (`/usr/local/sbin`, `/usr/sbin`, `/usr/local/bin`).
- `upgrade` télécharge l'actif `edge-setup_linux_<arch>` et retombe sur
  `hermes-setup_linux_<arch>` si une release ne liste que l'ancien nom ;
  `make build-all`/`release`/`publish` publient les deux noms dans
  `SHA256SUMS` et sur GitHub.
- Variables d'environnement : `EDGE_SETUP_COLOR` et `EDGE_SETUP_NO_SUDO`
  remplacent `HERMES_SETUP_COLOR`/`HERMES_SETUP_NO_SUDO`, qui restent
  honorées si la nouvelle variable n'est pas définie. `DEPLOY_KEY_FILE`
  vaut désormais `~/.config/edge-setup/deploy.key` par défaut, avec repli
  sur `~/.config/hermes-setup/deploy.key` s'il existe seul.
- Inchangé, gelé par l'ADR du renommage : les routes `/hermes-setup/*`,
  `connector.HostPrefix`, l'unité `hermes-setup-upgrade.{service,timer}`,
  les répertoires d'état `/etc/hermes`, `/var/lib/hermes-setup`, et le
  domaine HMAC `hermes-setup upgrade v1`. `RELEASES_REPO` reste
  `MakFly/edge-setup-releases`.

## v0.5.3 - 2026-09-16

### Checkout Hermes réconcilié automatiquement

- `edge-setup up` réinitialise automatiquement le checkout Hermes géré quand
  il contient des modifications locales, puis poursuit l'installation du
  commit épinglé.
- Le gateway est arrêté avant la réinitialisation et l'intégrité finale du
  checkout, du commit et des droits reste vérifiée.

## v0.5.1 - 2026-09-15

### SSH admin : plusieurs clés

- `Finalize` et un `up` ultérieur n'exigent plus que `authorized_keys` de
  `hermes-admin` ne contienne que la clé du bootstrap. La clé vérifiée doit
  rester présente ; les clés ajoutées par l'opérateur (un second poste) sont
  conservées. `--admin-key` pose toujours une seule clé au premier
  provisionnement.

## v0.4.0 - 2026-09-14

### Les releases ne sont plus signées

- minisign disparaît : plus de `SHA256SUMS.minisig`, de clé embarquée, de
  `packaging/minisign.pub`, de `packaging/resign.sh`, de `make resign` ni de
  secret `MINISIGN_KEY`. Une release publie les binaires et `SHA256SUMS`.
- `upgrade`, `upgrade --auto` et `self-verify` font confiance à HTTPS vers le
  dépôt de releases, comme l'installation, puis vérifient le SHA-256 du binaire
  contre `SHA256SUMS`. Une release sans signature n'est plus refusée.
- `make publish VERSION=vX.Y.Z` publie depuis le poste, sans cérémonie de
  signature, quand GitHub Actions ne peut pas tourner.

### Mise à jour automatique, optionnelle et prouvée

- `auto-upgrade enable --yes` pose `hermes-setup-upgrade.timer` (toutes les
  6 h, délai aléatoire, rattrapage au démarrage) ; `disable --yes` le retire,
  `status` lit le dernier passage. Désactivé par défaut.
- `upgrade --auto` n'installe qu'une release `vX.Y.Z` strictement plus récente
  dont le binaire correspond à son `SHA256SUMS`, hors transaction, et repousse
  de 24 h au plus quand des runs sont en cours. Une release illisible est
  inscrite `blocked`, jamais installée.
- Le nouveau binaire doit être admis de nouveau par OpenHermesBot sur chaque
  connecteur actif avant l'upgrade (marqueur `link-admitted`) ; sinon le
  binaire précédent, gardé dans `hermes-setup.previous`, est remis et prouvé,
  et la release rejetée n'est plus retentée. `status` et `doctor` le disent.
- Un `upgrade` manuel et un passage automatique ne tournent plus en même temps.

### Un lien refusé ralentit au lieu de s'arrêter

- Après 10 refus consécutifs, le connector écrit `link-refused` puis réessaie
  toutes les 30 min au lieu de sortir en 78. Un refus causé côté
  OpenHermesBot se répare donc sans intervention sur l'hôte. Seule une
  révocation (4004) arrête encore l'unité.
- `doctor` signale le marqueur même quand l'unité tourne.

### `upgrade` ordonne correctement un build `git describe`

- `v0.3.0-1-g44c185a-dirty` passait pour plus ancien que `v0.3.0-dirty` :
  semver comparait les deux suffixes comme du texte. Un build compte désormais
  comme son tag plus les commits qui le suivent.

### Une reconnexion demandée par OpenHermesBot repart en 1 s

- Nouvelle fermeture 4005 `LINK_RECONNECT_REQUESTED` : OpenHermesBot raccroche
  une session dont le ping WebSocket reste sans réponse. Le connector redial
  après 1 s, sans garder son backoff d'incident, et ne compte pas cette
  fermeture comme un refus.
- Correctif : un connector déjà en service ne se reconnectait plus. L'ancre
  de l'audit armé et le diagnostic de la coupure partaient juste après
  `hello`, avant `link.proof` ; la passerelle, qui n'accepte que la preuve à ce
  stade, fermait 4401 `LINK_POP_FAILED`, en boucle, jusqu'au redémarrage du
  processus. Ancres et diagnostics partent désormais après la preuve (sans
  attendre quand l'hôte n'a pas de clé device ou pendant un enrôlement, après
  `PoPWindow` face à un broker qui ne challenge pas).

### Un lien refusé s'arrête au lieu de frapper sans fin

- Le connector compte les refus consécutifs d'OpenHermesBot (montée HTTP 401
  ou 403, fermeture 4401). Au **10e**, ou dès une révocation (4004), il écrit
  la raison dans `link-refused` et sort avec le code 78, que l'unité liste dans
  `RestartPreventExitStatus` : systemd ne le relance plus. Une coupure réseau
  ne compte pas, une session confirmée remet le compte à zéro.
- `status` affiche `refused` sur l'instance, et `doctor` donne la date, la
  raison et la commande `link` à jouer (avec `--name` pour une instance
  nommée). `link` efface le marqueur et redémarre l'unité.
- Auparavant, un runtime supprimé côté OpenHermesBot laissait son connector
  refusé en boucle pour toujours.

### `up` et `upgrade` reposent le garde loopback manquant

- Un hôte dont le pare-feu avait été choisi avant l'arrivée du garde loopback
  ne l'a jamais reçu : `doctor` le signalait et conseillait de rejouer `up`,
  mais ce rejeu ne l'installait pas et échouait à la finalisation. `up` et
  `upgrade` l'installent désormais quand le pare-feu est sélectionné et que
  les règles manquent, sans rien toucher sur un hôte déjà gardé.

## v0.3.0 - 2026-09-14

### Ubuntu et Debian 12 acceptés pour le runtime

- Le préflight de `detect` et `up` accepte **Debian 12 ou plus** et **Ubuntu
  24.04 ou plus** pour le runtime minimal : paquets de base, Python géré par
  uv, gateway sur loopback, opérateur et connector. Il n'exigeait que Debian 13.
- Ubuntu 22.04 reste refusé : systemd 249 n'a ni `systemd-creds` ni
  `LoadCredentialEncrypted`, qui scellent la clé device du connector.
- Toute protection optionnelle (`--sandbox`, `--firewall`, `--fail2ban`,
  `--ssh-hardening`, `--quarantine-cloud-user`, `--password-policy`,
  `--sudo-logging`, `--disable-llmnr`, `--unattended-upgrades`,
  `--persistent-journal`) reste réservée à Debian 13 et le préflight le dit en
  les nommant. Les épingles Docker sont des builds trixie, le compte cloud mis
  en quarantaine s'appelle `debian`, et les références UFW, PAM et
  unattended-upgrades n'ont été prouvées que là.
- Sous systemd < 257 (Debian 12, Ubuntu 24.04), `PrivatePIDs=` est ignoré :
  gateway et connector n'y ont pas d'espace PID privé.
- `make integration` accepte `HERMES_SETUP_IT_BASE` pour rejouer les scénarios
  minimaux sur `ubuntu:24.04` ou `debian:bookworm`.

### Une coupure de moins d'une minute n'est plus une alerte

- Les alertes Discord attendent **soixante secondes** avant d'annoncer la perte
  d'un composant. Une coupure plus courte n'est pas annoncée du tout : ni sa
  perte, ni son retour. Remplacer le processus OpenHermesBot ferme toutes les
  WebSockets des connecteurs, l'hôte reconnecte dans la seconde, et une carte
  par déploiement n'apprenait au lecteur qu'à ignorer le canal.
- La carte d'un incident confirmé porte désormais la durée réelle de la coupure
  au lieu de l'âge de la détection, qui affichait « moins d'une seconde » sur
  toutes les pertes.
- Un incident confirmé dont la carte n'a pas pu partir n'est pas oublié pour
  autant : il reste annoncé comme incident rétabli dès que Discord répond.
- Un composant encore dans son délai est nommé sur la carte qu'un AUTRE
  composant déclenche : un rétablissement ne dit jamais que tout est revenu
  pendant que l'autre est à terre.
- Journald garde la trace immédiate des deux transitions, comme avant : ce
  délai borne ce qui est publié, pas ce qui est observé.

## v0.2.1 - 2026-09-10

### Relier écrase : `link` devient un updateOrCreate

- **Rupture** : le drapeau `--replace` est retiré. `link` ne refuse plus une
  autre origine OpenHermesBot et n'a plus rien à déverrouiller : il écrit le
  lien de l'instance visée, quel qu'ait été le précédent. Basculer l'hôte du
  développement vers la production, ou l'inverse, est la même commande avec une
  autre `--openedbot`.
- Le refus n'a jamais été une frontière : `link` tourne en root sur l'hôte, et
  root réécrit `link.json` à la main de toute façon. Il n'était payé que par
  l'opérateur ayant une raison légitime de basculer. Ce qui borne réellement
  l'enrôlement reste en place et n'a pas bougé : le ticket à usage unique émis
  par un propriétaire authentifié dans OpenHermesBot, la restriction des
  origines `http://` à la loopback derrière `--insecure-openedbot`, et `reset` pour
  retirer le runtime pour de bon.
- Ce que le garde protégeait devient un devoir de parole. Avant même la lecture
  du ticket, la reprise nomme l'origine quittée et le runtime qui va s'y figer :
  cet OpenHermesBot garde une ligne `runtimes` que l'hôte ne rappellera plus, et
  seul l'opérateur peut l'y retirer. Un nouveau ticket sur l'origine déjà liée
  reste un ré-enrôlement, annoncé comme tel, pas une bascule.
- Après une bascule, les recouvrements du lien quitté (`link-token.json`,
  `link-context.json` du `StateDirectory`) sont retirés : ils étaient déjà
  inertes, indexés sur l'ancien runtime, mais `status` cessait de nommer un
  OpenHermesBot que l'hôte ne joignait plus.
- Les instances nommées (`--name`) ne changent pas : elles restent le moyen de
  tenir **deux** liens vivants en même temps, et prennent la main de la même
  façon sur leur propre lien.

### Mémoire d'un profil : lecture et écriture par le magasin de Hermes

- Feature `profile_memory` (`hello`) et deux routes hôte,
  `GET`/`POST /hermes-setup/profiles/{slug}/memory`, portées par les verbes
  `profile-memory-get`, `profile-memory-write` et `profile-memory-set`. Elles
  passent par le `MemoryStore` amont lui-même, jamais par un accès fichier à
  `MEMORY.md` / `USER.md` : mêmes plafonds, même délimiteur, même
  dédoublonnage et même filtre d'injection que l'outil `memory` du bot.
- L'interrupteur est le toolset `memory` du profil. `profile-memory-set` aligne
  `memory.memory_enabled` et `user_profile_enabled` du `config.yaml` du profil,
  sans lesquels l'outil amont n'est pas enregistré dans la session
  (`check_memory_requirements`) quelle que soit la liste `platform_toolsets` ;
  tant qu'il est au repos, le magasin refuse l'écriture (`MEMORY_DISABLED`).
- Sonde d'inventaire (`inventory_probe.py`) et lecture des capacités par profil
  (`profile_capabilities.go`) étendues en conséquence. Un hôte plus ancien
  n'annonce pas `profile_memory` : OpenHermesBot le dit à l'écran au lieu de
  présenter une mémoire vide.
- `docs/CONNECTOR.md` et la page publique `connector.mdx` publient les deux
  routes ; le contrat qui les compare (`internal/docs`) est de nouveau vert.

Côté OpenHermesBot, c'est désormais la SEULE mémoire d'un bot : le régime
propre au SaaS (table de faits, lignes `remember:`, approbation, extraction
automatique) a été retiré le 2026-09-07.

## v0.2.0 - 2026-09-06

### Alertes Discord : environnement, instance et utilisateur

- OpenHermesBot pousse `link.context` juste après la liaison (palier `dev` /
  `preprod` / `prod`, origine, organisation, propriétaire). L'enrôlement
  l'écrit dans `link.json` (`openedbot_environment`, `organization`, `owner`) ; le
  démon le garde en mémoire et le rafraîchit dans
  `$STATE_DIRECTORY/link-context.json`, au mieux, comme le jeton tourné. Un
  hôte plus ancien ignore la trame.
- La carte Discord titre `[<palier>] …` et porte **Environnement**,
  **Instance** (`default` ou `--name`), **openedbot** (hôte de l'origine) et
  **Utilisateur** (e-mail du propriétaire, organisation), `inconnu` tant
  qu'aucune session ne l'a déclaré. Plusieurs déploiements partagent un canal
  et un VPS porte un lien dev et un lien prod : une alerte qui ne dit pas
  d'où elle vient n'est pas actionnable.
- `status` ajoute `env=<palier> owner=<e-mail>` par instance
  (JSON `openedbot_environment`, `organization`, `owner`).

### Correctif : enrôlement avec clé device

- La session d'enrôlement (ticket) sert la sonde d'OpenHermesBot sans
  attendre `link.challenge` : le runtime n'existe pas encore, aucun challenge
  n'est possible, et l'enrôlement enregistre la clé de `hello`. Avant, tout
  enrôlement fait avec une clé device échouait en `LINK_POP_PENDING` →
  `LINK_PROBE_FAILED` (4003), quel que soit le broker.

### Instances de connecteur nommées

- `link --openedbot URL --name <name>` (`^[a-z][a-z0-9-]{0,31}$`) crée une
  instance nommée : `/etc/hermes/connector/<name>/{link.json,device.key.cred}`,
  unité `hermes-connector@<name>.service` (template `hermes-connector@.service`,
  `StateDirectory=hermes-connector/%i`), journal des runs, spool et audit de
  création sous `/var/lib/hermes-connector/<name>`. Le bearer du gateway reste
  partagé : les deux OpenHermesBot voient la même surface gateway. Sans
  `--name`, chemins et unité sont inchangés ; aucune migration.
- Garde : `link` refuse de relier une instance déjà liée à une **autre**
  origine OpenHermesBot ; le refus (avant la lecture du ticket) donne l'origine
  courante et propose `--name dev`. `--replace` force l'écrasement. C'est le
  cas mesuré : un `link` de développement écrasait le lien de production, et
  l'API locale répondait `503 RUNTIME_LINK_UNAVAILABLE`.
- `status` liste chaque instance (origine `openedbot`, `runtime_id`, unité active,
  clé device scellée) ; JSON `connectors[]`. `link --rekey --name <name>`,
  `doctor` et `audit` couvrent les instances nommées. `up`/`upgrade`
  installent le template, scellent une clé pour chaque instance liée sans
  clé, et `try-restart` chaque unité connecteur. `reset` arrête
  `hermes-connector@*` et retire le template.

### Modèle par profil

- `POST /hermes-setup/profiles/{slug}/model` `{provider, model}` écrit
  `model: {provider, default}` dans le `config.yaml` du profil (les autres
  clés du bloc sont conservées). La sonde `profile-model-set` relit, et la
  route rend `{profile, provider, model}` depuis l'inventaire. Bornes :
  `[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}`. Erreurs `PROFILE_INVALID`,
  `PROFILE_NOT_FOUND`, `BODY_INVALID`. Annoncé sous `profile_capabilities`.
  Jumeau de `profiles.configure { model, provider }` : sous un profil
  multiplexé le gateway ignore le `provider` du `POST /v1/runs` et lit
  `model.provider` dans ce fichier.
- `POST /hermes-setup/profiles` accepte `provider` et `model` optionnels et
  écrit le même bloc à la création, dans le même try que le bearer
  (`API_SERVER_KEY`) : un échec nettoie le profil.

### Skills et credential par profil

- `POST /hermes-setup/profiles/{slug}/skills/{skill}` `{enabled}` bascule une
  skill du dossier `skills/` du profil. La sonde `profile-skill-set` écrit
  `disabled_skills` (et `skills.disabled`) dans son `config.yaml` ; `enabled`
  est relu sur l'inventaire. `404 SKILL_NOT_FOUND` si le dossier ne porte pas
  cette skill. Annoncé sous `profile_capabilities`.
- `POST` / `DELETE /hermes-setup/profiles/{slug}/providers/{provider}/credentials`
  pose ou retire une clé fournisseur propre au profil. Preuve :
  `/p/<slug>/api/model/options`. La clé voyage sur stdin, jamais en argv, en
  journal ni en réponse. Annoncé par `profile_credentials` sous les mêmes
  conditions que `profile_management`.
- Le miroir racine → profils ne recouvre plus une clé marquée
  `# openedbot:profile-own` (fichier `.env.openedbot-own`).

### Mémoire par profil

- `memory` et `session_search` restent `403 TOOLSET_FORBIDDEN` sur
  `POST /hermes-setup/toolsets/{toolset}` (racine). Sur
  `POST /hermes-setup/profiles/{slug}/toolsets/{toolset}` ils sont
  acceptés : le profil a son propre magasin. `cronjob` et `delegation`
  restent refusés partout. Même scission que `runtime-contract.ts`.

### Profils Hermes par le lien

- L'opérateur sert `GET /hermes-setup/profiles` et
  `GET /hermes-setup/profiles/{slug}/avatar` : une lecture nommée des agents
  déjà présents sur l'hôte (hors `default`), sans `.env`, mémoires ni
  sessions. Annoncée par `profile_inventory` seulement si le verbe `profiles`
  est servi. `profile_management` crée et supprime un profil cloné depuis
  `default`, et `profile_capabilities` relit les toolsets/MCP par profil quand
  le multiplexage est actif.

### OAuth MCP et redémarrage du gateway par le lien

- Un serveur MCP `auth: oauth` installé depuis OpenHermesBot restait inerte :
  `install_entry` amont n'écrit que le marqueur et attend « le navigateur à la
  première connexion », qu'un hôte sans écran n'a pas. L'opérateur sert
  désormais quatre verbes `…/mcp/servers/{server}/oauth…` qui jouent le flux
  du Dashboard Hermes avec OpenHermesBot pour jambe navigateur : l'URL
  d'autorisation sort, le callback `{code, state}` revient, `state` est
  validé sur l'hôte, et la session n'est `connected` qu'après relecture du
  jeton sur le disque et listage des outils. Programme d'autorisation Python
  embarqué, longue durée, installé à côté du programme d'inventaire.
- L'inventaire MCP porte `oauthTokenPresent` : un serveur enregistré sans
  jeton se lit comme tel.
- Le gateway ne lit ses serveurs MCP qu'au démarrage : chaque écriture MCP
  pose un marqueur « redémarrage en attente », lisible sur
  `GET /hermes-setup/gateway`, et `POST /hermes-setup/gateway/restart` (le
  seul redémarrage que le lien porte, route et unité fixes, aucun argument)
  redémarre `hermes-gateway` et le prouve sur `/health`. Un redémarrage joué
  depuis la console retire le marqueur.
- `hello` et `/v1/capabilities` annoncent `mcp_oauth` et `gateway_restart`
  seulement quand l'opérateur peut les servir.

### Provisionnement optionnel

- `up --yes` installe désormais uniquement le socle runtime : l'unique compte
  système `hermes`, le gateway loopback, le connector et leurs confinements
  systemd. Docker rootless, journal persistant, mises à jour automatiques,
  journal sudo, pwquality, LLMNR, UFW, fail2ban, SSH et quarantaine cloud-init
  sont activés séparément par des options positives.
- Les anciens drapeaux négatifs sont supprimés. Une relance conserve les
  protections déjà sélectionnées et peut en ajouter ; leur omission ne les
  désactive pas. L'audit rend les contrôles non sélectionnés en `SKIP`.
- UFW est audité avant mutation : une politique active default-deny compatible
  est conservée et complétée avec les seuls `--allow-inbound` déclarés ; un
  conflit est refusé sans écrasement ni `ufw reset`.
- Le connector partage désormais l'unique uid `hermes` avec le runtime, avec
  des namespaces systemd qui masquent réciproquement leurs données et processus.

### Toolsets

- `up` provisionne désormais `skills` sur la plateforme `api_server`, avec
  `web`, `terminal`, `file`, `code_execution`, `vision`, `image_gen`, `bfl` et
  `todo`. C'est le toolset par lequel un bot apprend : OpenHermesBot réécrit
  « apprends X » en skill écrit par `skill_manage` et relu par `skill_view`,
  uniquement quand l'inventaire l'annonce actif. Un runtime déjà installé ne
  change pas : l'opérateur l'active depuis Réglages → Connecteurs ou avec
  `hermes-setup toolsets enable skills`. `ForbiddenToolsets` est inchangé.

### Lien connecteur

- L'allowlist relaie désormais `DELETE /api/sessions/{id}`, la seule route
  destructive qu'elle porte vers le gateway. OpenHermesBot l'appelle quand un
  opérateur purge un bot qu'il avait mis à la corbeille : la session
  `openedbot:<org>:<thread>` et son transcript disparaissent du runtime. Elle ne
  peut viser aucun autre identifiant, et ne touche ni le profil, ni un fichier,
  ni l'hôte. Un connecteur antérieur à cette entrée la refuse en
  `HERMES_LINK_PATH_FORBIDDEN` : la purge côté SaaS le signale à l'opérateur
  au lieu de conclure que les données ont été effacées.

### Chaîne de confiance

- Route d'installation publique unifiée ajoutée au site ; après déploiement de
  `hermes-setup.openedbot.app`, la commande canonique sera
  `curl -fsSL https://hermes-setup.openedbot.app/install | sh`. Le bootstrap
  fait confiance à HTTPS, à ce domaine et au dépôt public de releases GitHub,
  choisit l'architecture et vérifie le SHA-256 sans demander `minisign` sur
  l'hôte.
- Signature minisign obligatoire pour les **mises à jour** : chaque `upgrade`
  de release vérifie une fois `SHA256SUMS.minisig`, puis le SHA-256, avec la clé
  embarquée avant d'écrire. `self-verify` reste un diagnostic manuel ; aucune
  vérification n'a lieu à chaque commande.
- `make deploy` et `upgrade --from FICHIER --sha256 HEX` restent la voie
  interne, via SSH, pour tester un build local non publié.
- `make release` et `make publish` refusent une release non signée.
- `--release-url` accepté en `https://` seulement ; une redirection qui quitte
  HTTPS est refusée.
- Anti-downgrade : `upgrade` refuse une version antérieure à celle installée,
  sauf `--allow-downgrade`.

### Lien OpenHermesBot

- L'allowlist du connecteur relaie désormais `GET /api/sessions/{id}/messages`
  en lecture seule. OpenHermesBot peut ainsi relire le transcript réel à la
  fin d'un run et reconstruire le plan Todo sans modifier Hermes upstream ni
  inventer une progression à partir d'un timer.
- Après un `make deploy`, `hermes-connector` est redémarré et le runtime doit
  être retesté depuis OpenHermesBot avec « Tester » pour réannoncer le contrat
  de capacités.
- En développement, `link --insecure-openedbot` accepte une origine `http://` **de la
  loopback** : celle qu'un tunnel SSH inverse (`ssh -R 8790:127.0.0.1:8790`,
  ou `make link-tunnel` côté openedbot) place devant cet hôte. Le lien passe alors en
  `ws://` sur cette loopback, dans SSH. Publier l'application de développement
  sur Internet pour la seule contrainte d'un schéma `https://` n'est plus
  nécessaire. Sans le drapeau, et pour toute origine non-loopback avec, `--openedbot`
  exige toujours `https://`.
- L'origine `--openedbot` est validée avant la barrière root : une faute de frappe se
  voit sans `sudo`, et rien n'est muté dans les deux cas.
- En développement, le connector peut aussi viser l'origine HTTPS/WSS de
  l'application openedbot locale publiée par Cloudflare Tunnel. Le tunnel reste côté
  application, jamais devant le gateway du VPS.
- En production, une fois celle-ci déployée, le même connector vise l'origine
  openedbot stable.

### Secrets

- `link` lit le ticket d'enrôlement sur stdin ou via
  `--ticket-file` (0600). L'argument positionnel est refusé : il apparaissait
  dans la table des processus et dans `/var/log/sudo.log`.
- Le refus des flags secrets s'applique à **toutes** les commandes, dans
  `cli.Run`, avant la ré-exécution sudo.

### Bornes et périmètre

- Connecteur : ping WebSocket toutes les 15 s avec pong sous 30 s, 60 s
  jusqu'au premier `res`, flux `events` inactif 15 min. Sans elles, un lien
  coupé par un NAT restait « connecté » et une route lente immobilisait un
  des 64 créneaux.
- Opérateur : un seul `hermes auth add` à la fois, 409 `CREDENTIAL_IN_PROGRESS`
  au-delà.
- `reset` ne supprime plus le `20auto-upgrades` de Debian (ce qui désactivait les mises à jour de
  sécurité). Tailscale n'est purgé qu'avec `--purge-tailscale`.
- `verify-access` exige toujours la preuve temporelle de la session sshd :
  `SSH_CONNECTION` seul ne prouvait pas qu'elle avait été ouverte après le
  verrouillage.
- `hermes-operator.service`, seule unité root, reçoit un jeu de capacités
  borné, `RestrictNamespaces` et un filtre d'appels système.
- `export --md` est effectif ; `update --self` transmet tous les flags.

### Outillage

- Intégration continue : `make check LINT_STRICT=1` (staticcheck et
  govulncheck bloquants), `make check-docs`, compilation croisée et build du
  site à chaque modification du module.
- `make lint` distingue un outil absent d'un outil en échec ; l'ancien
  enchaînement masquait un échec de staticcheck.
- `make check-docs` compare les blocs de commandes de `docs/` et du site.
- Les épingles ne sont plus recopiées hors de `internal/pins` (test dédié).
- Dépendances `golang.org/x/*` remontées pour govulncheck. La directive `go`
  passe de 1.23.4 à **1.26.0** : construire le binaire demande désormais cette
  version, ce qui ne change rien aux hôtes, qui reçoivent un binaire statique.

### Documentation

- Nouvelle section « Développement » sur le site : appairer un VPS à une
  OpenHermesBot locale par tunnel SSH inverse, règle exacte de
  `--insecure-openedbot`, ce que le Quick Tunnel Cloudflare publie et quand il reste
  justifié, dépannage. `getting-started`, `connector` et la table des commandes
  pointent dessus.
- Site remanié : prérequis, installation, dépannage, sécurité,
  plan de navigation, sitemap, robots et page 404. Les pages mainteneur
  (développement, provenance, historique tailnet, changelog, garanties,
  modes) sortent de la sidebar publique.
- Les liens GitHub pointaient vers un dépôt introuvable ; ils visent le dépôt
  public des releases.
- Plus de `sudo` après le premier `up` dans les exemples, y compris la page
  d'accueil qui contredisait toute la documentation.

## v0.0.3 (ancien dépôt)

Première release publique : binaires `linux/amd64` et `linux/arm64`,
`SHA256SUMS`. Date : à confirmer.
