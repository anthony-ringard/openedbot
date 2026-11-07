# edge-setup

Un binaire, exécuté **sur la machine du client** (VPS ou homelab, Debian 12+
ou Ubuntu 24.04+ sur `amd64` ou `arm64`, systemd ; Debian 13 pour les
protections optionnelles ; cgroup v2 si sandbox), qui installe un runtime
[Hermes](https://github.com/NousResearch/hermes-agent) épinglé et le relie à
openedbot. Le durcissement global du système est entièrement optionnel.

```text
 machine du CLIENT (VPS / homelab)                    origine openedbot
 +--------------------------------------+            +------------------------+
 | edge-setup up . link . credentials |            | prod :                 |
 | Hermes gateway 127.0.0.1:8642        |            | openedbot.app          |
 |   uid hermes, sandbox optionnelle    | connector  | dev : app locale sur   |
 | hermes-connector (lien sortant wss)  | =========> | la loopback du VPS     |
 |   bearer local, aucun port entrant   |            | broker <- worker       |
 +--------------------------------------+            +------------------------+
```

openedbot ne parle qu'au **gateway** (`/v1/runs`, SSE, `/v1/toolsets`,
`/api/model/options`) et aux verbes nommés de l'opérateur (`/hermes-setup/*`),
dont la gestion des profils et capacités (`POST/DELETE /hermes-setup/profiles`,
toolsets/MCP/skills par profil, credential propre à un profil) est annoncée par
`profile_management`, `profile_credentials` et `profile_capabilities`, en plus
de la lecture (`GET /hermes-setup/profiles`, capacité `profile_inventory`). Le mode `connector` est le défaut : l'hôte ouvre une
connexion sortante, le bearer ne le quitte jamais et aucun port applicatif
entrant n'est ouvert. C'est l'unique architecture documentée.

Les releases sont signées sans clé avec Sigstore : le workflow
`.github/workflows/edge-setup-release.yml`, exécuté sur le tag
`edge-setup/vX.Y.Z`, signe `SHA256SUMS` par OIDC GitHub, et la signature
(`SHA256SUMS.sigstore.json`) est publiée à côté du manifeste. Le seul
signataire accepté pour la version `vX.Y.Z` est l'identité de certificat
`https://github.com/OpenedBot/openedbot/.github/workflows/edge-setup-release.yml@refs/tags/edge-setup/vX.Y.Z`,
émise par `https://token.actions.githubusercontent.com`. Chaque release vit
sous `https://releases.openedbot.app/edge-setup/vX.Y.Z/`, immuable ;
`https://releases.openedbot.app/edge-setup/LATEST` nomme la plus récente.

Le bootstrap public est servi par `docs.openedbot.app/install` : il installe la
release avec laquelle il a été publié (jamais une « dernière » implicite ;
`--version latest` est explicite), télécharge `SHA256SUMS` et sa signature,
vérifie la signature pour l'identité de cette version avec un cosign épinglé
dont le SHA-256 est écrit dans le script, puis seulement télécharge le binaire
et vérifie son SHA-256. `sh -s -- --dry-run` fait toutes les vérifications et
affiche l'étape d'installation sans rien écrire. `upgrade`, `auto-upgrade` et
`self-verify` font les deux mêmes contrôles, dans le même ordre ; une release
sans signature (toutes jusqu'à v0.0.2) est refusée, la première release signée
est v0.0.3. Si l'origine ne répond pas ou qu'un contrôle échoue, le bootstrap
et `upgrade` échouent sans rien installer ; il n'y a aucun repli vers GitHub.

## 1. Installer Hermes

```bash
# À exécuter une fois docs.openedbot.app et releases.openedbot.app servis
curl --proto '=https' --tlsv1.2 -fsSL https://docs.openedbot.app/install | sh

sudo edge-setup detect
sudo edge-setup up --yes
```

Ce parcours minimal crée l'unique compte système non privilégié `hermes`,
installe le runtime, garde le gateway sur loopback et installe le connector
sortant. Il ne modifie ni SSH, ni UFW, ni fail2ban, ni PAM, ni journald, ni la
politique de mises à jour du client.

Exemple de profil renforcé explicite :

```bash
sudo edge-setup up \
  --sandbox --persistent-journal --unattended-upgrades \
  --sudo-logging --password-policy --disable-llmnr \
  --firewall --allow-inbound 22/tcp --fail2ban \
  --ssh-hardening --quarantine-cloud-user \
  --admin-key /root/admin.pub --console-confirmed --yes
#   … depuis un AUTRE terminal, dans les 600 s :
ssh hermes-admin@203.0.113.10  &&  edge-setup verify-access
edge-setup doctor
edge-setup audit --strict
```

Le bootstrap ne vérifie que l'architecture Linux, la signature et le SHA-256. `detect` et
`up` imposent ensuite le périmètre réellement supporté : Debian 12+ ou
Ubuntu 24.04+, `amd64` ou `arm64` et systemd. Toute protection optionnelle
(sandbox, pare-feu, SSH, PAM, journal, mises à jour) exige Debian 13. Ubuntu
22.04 est refusé : son systemd 249 ne scelle pas la clé du connector
(`systemd-creds`, `LoadCredentialEncrypted`). Sous systemd < 257 (Debian 12,
Ubuntu 24.04), `PrivatePIDs=` est ignoré par systemd : le connector n'y a pas
d'espace PID privé. Le gateway n'en a sur aucune version : Hermes 0.22 prouve
son gateway vivant depuis la vue des processus de l'hôte. Cgroup v2 n'est exigé que par
`--sandbox`.

Sans `docs.openedbot.app`, le binaire se pose depuis une release épinglée de
l'origine publique, avec la même vérification que le bootstrap (il faut
[cosign](https://docs.sigstore.dev/cosign/system_config/installation/)) :

```bash
V=vX.Y.Z   # la release à installer ; https://releases.openedbot.app/edge-setup/LATEST nomme la plus récente
U=https://releases.openedbot.app/edge-setup/$V
A=edge-setup_linux_$(dpkg --print-architecture)
curl --proto '=https' --tlsv1.2 -fsSL -O "$U/$A" -O "$U/SHA256SUMS" -O "$U/SHA256SUMS.sigstore.json"
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity "https://github.com/OpenedBot/openedbot/.github/workflows/edge-setup-release.yml@refs/tags/edge-setup/$V" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
sudo install -m 0755 "$A" /usr/local/sbin/edge-setup
```

Arrêtez-vous si `cosign` n'affiche pas `Verified OK` ou si `sha256sum`
n'affiche pas `OK`.

## 2. Relier le gateway sécurisé à openedbot

En développement, la voie normale est un **tunnel SSH inverse** : le poste
n'est pas publié, et le VPS atteint le point d'entrée openedbot local sur sa propre
loopback. `make link-dev-up` démarre la passerelle locale en mode `separate`,
ouvre le tunnel et lie l'instance au nom du poste (un port VPS par poste) avec
un ticket de l'openedbot locale.
`link --openedbot` n'accepte une origine `http://` que sur la loopback, et seulement
derrière `--insecure-openedbot` :

```bash
# Machine de développement, à la racine du dépôt openedbot ; l'API doit déjà répondre sur :8790 (make dev)
make link-dev-up HOST=hermes-admin@203.0.113.10

# À la main sur le VPS ; l'origine est la loopback du VPS
edge-setup link --openedbot http://127.0.0.1:8790 --yes --insecure-openedbot --name dev
# Coller le ticket à l'invite masquée. `--name dev` évite d'écraser un lien
# de production posé sur le même hôte (docs/CONNECTOR.md, « Instances nommées »).
```

Le lien voyage dans SSH, jamais en clair sur le réseau, et rien n'est exposé
sur Internet. `make link-dev-down` le ferme : le connecteur se reconnecte en boucle jusqu'à
sa réouverture.

Une origine `http://` publique ou LAN reste refusée, même avec le drapeau.

Ce que seul un vrai HTTPS permet (installation PWA, OAuth Google depuis un
mobile) se vérifie d'abord sur une VM. Un tunnel Cloudflare
lancé à la main reste une option avancée, jamais devant le gateway du VPS.

## Commandes

| Commande | Lecture seule | Effet |
|---|---|---|
| `detect` | oui | Faits de l'hôte, mode recommandé, préflight. |
| `plan` | oui | Ce que `up` ferait, sans rien écrire. |
| `up` | | Installe le runtime minimal sous l'unique compte `hermes`, le gateway loopback et le connector. Chaque protection globale (`--sandbox`, journal persistant, mises à jour, sudo, PAM, LLMNR, UFW, fail2ban, SSH et quarantaine) est opt-in. Sous Linux, `up` active aussi le timer de mise à jour automatique une fois réussi (comme `auto-upgrade enable --yes`), sauf `--no-auto-upgrade` ou un refus déjà retenu ; il se termine alors par un conseil qui nomme `sudo edge-setup auto-upgrade enable --yes`. `--auto-upgrade` l'active même après un refus. |
| `verify-access` | | Depuis une **nouvelle** session SSH : prouve l'accès admin et désarme le rollback. |
| `link --openedbot URL` | | Handshake du lien connector, jeton persisté 0600, démon démarré. Le ticket arrive par stdin ou `--ticket-file` (0600), jamais en argument. `--insecure-openedbot` accepte en plus une origine `http://` **de la loopback** (tunnel SSH inverse de développement) ; toute autre origine `http://` reste refusée. `--name <name>` crée une instance nommée (`hermes-connector@<name>.service`, `/etc/hermes/connector/<name>/`, état séparé) à côté du lien par défaut : dev et prod sur un même hôte. `link` est un *updateOrCreate* : il écrit le lien de l'instance visée quel qu'ait été le précédent, vers un openedbot de développement comme vers la production. Aucun drapeau à lever, `--replace` a été retiré. La reprise est annoncée avant la lecture du ticket, avec l'origine quittée et le runtime qui s'y fige. Un lien réussi se termine par le même conseil que `up` tant que la mise à jour automatique est désactivée. |
| `credentials list\|add\|login\|remove` | | Clé fournisseur par stdin ou fichier 0600, ou OAuth par code d'appareil (`login`), prouvés via `/api/model/options`. openedbot pose les mêmes accès depuis son interface via le connector. |
| `doctor`, `audit [--strict]`, `status`, `export` | oui | Lecture seule (`audit` écrit un rapport root-only, le flag `ReadOnly` du verbe reste vrai). |
| `upgrade --yes [--release-url URL]` | | Télécharge une release en HTTPS, vérifie la signature Sigstore de son `SHA256SUMS` puis, une fois, le SHA-256 du binaire contre ce manifeste, remplace le binaire puis redémarre `hermes-operator` (toujours) + `try-restart hermes-connector` et chaque `hermes-connector@<name>` s'ils existent (clé device scellée pour chaque instance liée qui n'en a pas). Il réécrit aussi `hermes-gateway.service` quand elle diffère de l'unité que ce binaire rend avec les paramètres de `up` : si ses directives changent, le gateway redémarre et `/health` est prouvé quand l'hôte est au repos (ni transaction ni run en cours), sinon le marqueur « redémarrage en attente » est posé et le redémarrage reste au propriétaire ; si seuls des commentaires ou des lignes vides changent, l'unité est réécrite et rechargée sans redémarrage ni marqueur ; un gateway qui ne répond pas retrouve l'unité précédente et l'étape échoue. `update --self` en est l'alias. `update` seul sort 69 (non implémenté). |
| `auto-upgrade enable\|disable --yes`, `auto-upgrade status` | | Pose ou retire `hermes-setup-upgrade.timer` (toutes les 6 h) : `upgrade --auto` n'installe qu'une release `vX.Y.Z` plus récente, signée et conforme à son `SHA256SUMS`, hors transaction et hors run en cours, prouve le lien sur le nouveau binaire et remet l'ancien sinon. Actif par défaut après `up` sous Linux ; `disable` est retenu pour les `up` suivants, et `doctor` avertit tant qu'il est éteint. |
| `self-verify [--release-url]` | oui | Diagnostic manuel : vérifie la signature du `SHA256SUMS` de la release, puis que le binaire courant y figure. Il n'est pas exécuté à chaque commande. Pas de root. |
| `internal` | | Points d'entrée des unités systemd (`rollback-access`, `connector`, `operator`). Pas un verbe opérateur. |
| `reset --yes …` | | Retire tout ; `--legacy` purge l'ancien namespace `openhermesbot-*` ; tailscale n'est retiré qu'avec `--purge-tailscale` (il est souvent votre accès). |
| `uninstall --yes …` | | Désinstalle `edge-setup` de l'hôte : le même retrait que `reset`, plus les commandes `edge-setup` et `hermes-setup` du PATH. Au terminal, demande s'il faut garder ou purger les données du runtime (purger exige de taper `purge`) ; hors terminal, `--keep-data` ou `--purge-data --i-understand-data-loss` est requis. Voir `docs/RESET.md`. |

Chaque mutation exige `--yes`. Une nouvelle option pouvant affecter l'accès
(`--firewall`, `--fail2ban`, `--ssh-hardening`, quarantaine) exige
`--console-confirmed`. Aucun flag n'accepte un secret. Les protections déjà
sélectionnées restent actives lors d'un `up` ultérieur ; omettre un flag ne les
désactive pas.

## Ce que l'hôte garantit

Épingles par commit et checksum (`internal/pins`) ; un seul compte `hermes`,
sans sudo ni groupe docker ; unités systemd cloisonnées ; sandbox rootless,
si sélectionnée, dont les limites cgroup sont **mesurées** ;
gateway sur loopback seul, anonyme refusé, catalogue d'outils exact ; sortie
vers les métadonnées cloud refusée par `IPAddressDeny` dans les unités gateway,
connector et operator (aucune ne porte `IPAddressAllow` sur ces plages : systemd
en évalue la liste avant le refus ; seule exception, un résolveur de
`/etc/resolv.conf` situé dans ces plages, autorisé seul en `/32` pour garder le
DNS, et par lequel les métadonnées restent joignables ; le stub de
systemd-resolved n'en a pas besoin dans les unités), et aussi par UFW si
`--firewall` est sélectionné, pour tout l'hôte : UFW filtre aussi les requêtes
amont de systemd-resolved, donc le résolveur lu dans `/etc/resolv.conf` ou dans
`/run/systemd/resolve/resolv.conf` n'y garde que le port 53 (udp et tcp), par
une règle `allow out` placée avant le refus, et le reste de cette adresse,
métadonnées HTTP comprises, reste refusé ; `up` refuse le pare-feu, avant tout
changement d'accès, si UFW ne peut pas poser cette règle, et un pare-feu posé
par une version antérieure la reçoit à `upgrade` ou à `up --yes` ; le filtre
d'unité exige le BPF cgroup, que systemd ignore sans
erreur quand le noyau ou le gestionnaire de conteneur ne l'offre pas (conteneur
LXC non privilégié) ; un hôte déjà installé reçoit les trois unités par
`upgrade` (mise à jour automatique comprise), le gateway n'étant redémarré que
si l'hôte est au repos (sinon le redémarrage reste en attente) ; `audit` et
`doctor` avertissent tant que l'unité gateway installée diffère de celle que le
binaire rend ; rollback
qui ne lit jamais l'état de l'outil ; aucune plateforme de messagerie activée
sur l'hôte sans allowlist ; par le connector, un lien qui ne relaie que
l'allowlist du gateway plus des verbes nommés servis par `hermes-operator` :
fournisseurs (clé API, OAuth démarrer/sonder/annuler), quotas en lecture seule,
toolsets, serveurs MCP et leur autorisation OAuth, et **un** redémarrage du
gateway (route fixe, unité fixe, aucun argument, prouvé sur `/health`) ;
jamais un shell, un chemin, un `exec` ni un `update`. La sonde de quotas
n'accepte ni credential ni argument libre et ne lit que les usages Anthropic
OAuth, Codex et OpenRouter exposés par Hermes.

Ce que l'hôte ne peut pas garantir : l'injection par le contenu qu'un agent
lit. Elle se traite par les approbations dans openedbot ; la sortie réseau
n'est pas filtrée, hors les plages de métadonnées cloud (`169.254.0.0/16`,
`fd00:ec2::/64`).

## Développement

```bash
make check            # gofmt, vet, tests unitaires hors ligne (goldens compris)
make build            # dist/edge-setup (cette machine)
make build-all        # linux + darwin, amd64 + arm64, install.sh et SHA256SUMS
make release          # build-all + contrôle de SHA256SUMS (+ .deb si nfpm), sans signature (seule la CI signe)
make publish VERSION=vX.Y.Z   # publie sur R2 (releases.openedbot.app) les fichiers signés par la CI du tag ; refuse -dirty, dev, une version déjà publiée
make contract-check   # contrat du lien des deux côtés (racine du monorepo, ..)
make check-docs       # miroir avec le site ../docs
make deploy HOST=user@host    # interne : build local + scp/SSH + upgrade --from + status
```

`make deploy` sert uniquement à tester un build non publié sur un hôte que le
développeur contrôle. Ce n'est ni le parcours d'installation public ni une
alternative à `edge-setup upgrade --yes` pour les releases.

`VERSION` vaut `$(git describe --tags --match 'edge-setup/v*' --always --dirty)`, sans le préfixe `edge-setup/`, par défaut : un
arbre sale suffixe `-dirty` et **change le binaire**. `make publish` refuse
ce suffixe et `dev` ; passer `VERSION=vX.Y.Z` explicitement.

Pousser un tag `edge-setup/vX.Y.Z` déclenche `.github/workflows/edge-setup-release.yml` (racine du monorepo), qui vérifie
le tag (contrat du lien des deux côtés, `make test`, `make test-release`,
`make build-all`) sans rien publier. La publication part de l'arbre propre du
tag : `make publish VERSION=vX.Y.Z` écrit dans R2, derrière
`https://releases.openedbot.app/edge-setup`, avec un jeton qui n'entre jamais
en CI. La numérotation est repartie de v0.0.1 avec le dépôt edge-setup ; depuis le monorepo OpenedBot/openedbot, les tags sont `edge-setup/vX.Y.Z`. Procédure :
[`docs/RELEASING.md`](RELEASING.md).

Le namespace disque vit dans `internal/layout`, les fichiers rendus dans
`internal/render` (gelés sous `test/golden/render/`), les vecteurs de trames
du connecteur dans `test/golden/relay-frames`, les mêmes que côté
openedbot. Provenance et ce qui a été porté verbatim de l'ancien outil
bash/Ansible : [`docs/PROVENANCE.md`](PROVENANCE.md).
