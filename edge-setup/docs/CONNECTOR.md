# Connecteur : contrat de fil entre `edge-setup` et openedbot

Ce document est **le** contrat partagé par les deux dépôts. Côté openedbot
il est incarné (dépôt `OpenedBot/openedbot`) par `protocol/connector/src/relay-frames.ts`,
`relay-allowlist.ts` et `relay-features.ts` (réexportés par `contracts/connector`) ; côté `edge-setup` par `internal/connector/frames.go`
et `allowlist.go`. Les vecteurs de test (`test/golden/relay-frames/`) sont
identiques dans les deux dépôts : une divergence casse un test des deux côtés.

## Pourquoi

openedbot ne parle qu'au gateway Hermes (`/v1/runs`, SSE, `/v1/toolsets`,
`/api/model/options`…). L'hôte du client ouvre **une** connexion WebSocket
sortante vers openedbot, et les requêtes gateway transitent par ce tuyau.
Aucun port applicatif entrant, aucun domaine, aucun certificat côté client ;
le bearer du gateway ne quitte jamais l'hôte.

Le protocole connector est identique dans les deux environnements. En
développement, `<openedbot>` est la loopback du VPS (`http://127.0.0.1:<port>`,
derrière `link --insecure-openedbot`) qu'un tunnel SSH inverse relie à l'application
openedbot locale ; l'origine HTTPS d'un tunnel Cloudflare lancé à la main reste une
option avancée. Un tunnel tourne côté
application, jamais sur le VPS et jamais devant le gateway. En production,
`<openedbot>` est l'origine de lien stable `https://link.openedbot.app`, celle
que `link` vise par défaut sans `--openedbot` (l'ancienne origine
`https://openedbot.app` reste acceptée). Le gateway reste
dans tous les cas sur `127.0.0.1:8642` : le connector sortant est l'unique
architecture documentée.

Le lien est un **canal de données** : il relaie exactement les routes gateway
de l'allowlist, rien d'autre. Aucun verbe exec/update/config, aucun shell ni
chemin de fichier ne transite par le fil, dans aucun sens. Le seul redémarrage
qu'il porte est `POST /hermes-setup/gateway/restart` : une route fixe, une
unité fixe (`hermes-gateway`), aucun argument, voir « Redémarrage du gateway
par le lien ».

## Cycle de vie

```
 hôte (unité hermes-connector)                    openedbot (apps/api)
 ──────────────────────                           ────────────────────────
 link (ticket sur stdin)
   ├─ GET wss://<openedbot>/api/runtime-links/ws
   │    Authorization: Bearer enrollment:<id>.<secret>   (ticket 5 min, usage unique)
   ├─ hello {protocol:1, agent, hermesVersion, features:[…], devicePublicKey}
   │  ◄── link.challenge {nonce}                  (preuve de possession, avant toute req)
   │  ──► link.proof {signature}
   │                                              connexion « provisional »
   │  ◄── req /health, /v1/capabilities, /v1/toolsets   (sonde à travers le tuyau)
   │  ──► res/end
   │                                              insert runtimes (reachability=connector),
   │                                              ticket brûlé, org runtime_mode=external
   │  ◄── link.context {environment, openedbot, organization, owner, limits, accepts}   (affichage : alertes, status ; borne des features ; trames facultatives acceptées)
   │  ◄── link.issued {runtimeId, linkToken}      (une seule fois, jamais en HTTP)
   └─ scelle la clé device (systemd-creds, TPM2 ou clé hôte) dans
      /etc/hermes/connector/device.key.cred, écrit link.json 0600
      (avec openedbot_environment, organization, owner), démarre hermes-connector.service

reconnexions : Authorization: Bearer link:<runtimeId>.<token>, hello porte
               devicePublicKey, link.challenge → link.proof avant toute req,
               puis link.context (persisté dans StateDirectory/link-context.json)
rotation     : link.rotate est persisté atomiquement dans StateDirectory avant
               que le nouveau jeton soit utilisé pour une reconnexion
```

En développement, `link --insecure-openedbot` accepte une origine `http://` **de la
loopback** de l'hôte : la montée est alors `ws://127.0.0.1:<port>/…`, le port
qu'un tunnel SSH inverse relie au poste de développement. Le fil reste chiffré
par SSH et le lien meurt avec le tunnel. Toute autre origine exige `https://`.

Le jeton de lien n'apparaît ni à l'écran, ni dans un journal, ni en argv ; il
est révoqué côté openedbot (`DELETE /api/runtime/:id` → fermeture 4004) et
remplacé par un nouvel enrôlement, jamais affiché.

## Trames

Trames **texte** (JSON, un objet par message) :

| `t` | Sens | Champs | Notes |
|---|---|---|---|
| `hello` | hôte → openedbot | `protocol` (1), `agent` (`edge-setup/<ver>`), `hermesVersion?`, `features?`, `devicePublicKey?` (base64, 32 octets Ed25519) | obligatoire en premier ; toute autre première trame → fermeture 4401. `features` : tableau d'au plus 64 chaînes `^[a-z0-9_]{1,64}$` (la borne que l'API annonce dans `link.context`, 16 tant que l'hôte n'en connaît pas d'autre : voir « Borne des features »), inconnues ignorées ; `provider_management` annonce les routes d'identification hôte, `provider_usage` la sonde de quotas, `profile_inventory` la lecture nommée des profils déjà présents, `profile_management` la création/suppression, `profile_credentials` la clé fournisseur d'un profil, `profile_capabilities` les toolsets/MCP/skills et le modèle par profil, `profile_bundled_skills` l'activation groupée des skills Hermes fournies avec le runtime, `sessions_inventory` la lecture bornée des identifiants de session par profil, et `skills_inventory` la liste des skills de la racine lue par l'opérateur (repli de `/v1/skills`). `profile_toolsets_batch` l'écriture groupée des toolsets d'un profil (`POST /hermes-setup/profiles/{slug}/toolsets`) ; sans elle, openedbot écrit un toolset par requête. `auto_upgrade` est un état, pas une route : le timer de mise à jour automatique de l'hôte est actif (la console ne propose alors plus de l'activer). `creation_audit_v2` est une feature du **lien**, annoncée dans `hello` seulement (jamais dans `capabilities` ni `/v1/capabilities`) : l'hôte tient un audit de création scellé et attend `audit.key` |
| `link.issued` | openedbot → hôte | `runtimeId`, `linkToken` | une fois, après commit |
| `link.context` | openedbot → hôte | `environment` (`dev` \| `prod`), `openedbot` (origine publique), `organization?` (`{id, name, slug}`), `owner?` (`{email, displayName?}`), `limits?` (`{features?}`), `accepts?` (types de trame) | optionnelle, juste après la liaison (après `audit.key`, avant `link.issued` à l'enrôlement) : quel openedbot et quel propriétaire sont derrière ce lien. Données d'affichage (alertes Discord, `status`), chaque texte ≤ 256 caractères, jamais un secret ; un hôte plus ancien ignore la trame (« ignoring frame: unknown frame type »). `limits` fait exception : `features` (entier ≥ 1, 64 aujourd'hui) est le nombre maximal de noms que l'API accepte dans `hello` et `capabilities`, que l'hôte retient et persiste (voir « Borne des features »). Un hôte plus ancien ignore ce champ, comme les seuils de version `latestVersion` et `minimumVersion` : `DecodeText` ne rejette pas les champs inconnus. `accepts` (au plus 16 types `^[a-z][a-z0-9_.]{0,63}$`) nomme les trames facultatives hôte → openedbot que cette API comprend : une API plus ancienne ferme le lien sur un type inconnu, l'hôte n'envoie donc une telle trame (aujourd'hui `inventory.changed`) que si elle y figure |
| `link.challenge` | openedbot → hôte | `nonce` (base64, 32 octets) | juste après `hello`, avant la liaison ; voir « Preuve de possession » |
| `link.proof` | hôte → openedbot | `signature` (base64, 64 octets) | réponse immédiate au challenge ; une `req` reçue avant est refusée `err before_dispatch LINK_POP_PENDING` |
| `audit.key` | openedbot → hôte | `runtimeId`, `keyId`, `key` (base64, 32 octets), `previous?` (≤ 2 `{keyId,key}`) | seulement si `hello.features` contient `creation_audit_v2` ; envoyée juste après la liaison, avant toute `req` ; jamais journalisée ; voir « Audit de création chiffré » |
| `audit.anchor` | hôte → openedbot | `runtimeId`, `keyId`, `writeSeq`, `count`, `dropped`, `tail` (hex 64) | après chaque écriture de l'audit et en début de session ; une ancienne API l'ignore |
| `capabilities` | hôte → openedbot | `features?` | même validation que `hello` (mêmes noms, même borne) ; remplace les capacités de l'opérateur sur le lien existant, sans fermer les requêtes en cours ; les features du lien annoncées dans `hello` (`creation_audit_v2`) restent acquises pour la session ; absent ou vide retire les capacités de l'opérateur |
| `inventory.changed` | hôte → openedbot | aucun | seulement si le dernier `link.context` la nomme dans `accepts`. Une fois par session, puis chaque fois que l'empreinte d'inventaire de l'opérateur bouge (`GET /inventory/fingerprint` sur sa socket, sondé toutes les 5 s : noms, tailles, modes et dates de `config.yaml`, `.env`, `mcp-tokens/*` et des `SKILL.md`, à la racine de `HERMES_HOME` et dans chaque profil, plus la config gérée ; jamais le contenu d'un fichier). openedbot inscrit le signal (`runtimes.inventory_changed_at`) et relit l'inventaire en arrière-plan ; tant que le lien tient, l'instantané d'un hôte qui a signalé sur la connexion en cours reste servi sans relire l'hôte. Un opérateur sans la route (404) : le connecteur cesse de sonder, sans rien envoyer |
| `diagnostic` | hôte → openedbot | `eventId`, `component`, `state`, `code`, `occurredAt`, `message`, `stack?` | incident borné, stocké sous le runtime authentifié ; aucune exécution du texte |
| `diagnostic.ack` | openedbot → hôte | `eventId` | seulement après commit, y compris pour un doublon déjà enregistré |
| `req` | openedbot → hôte | `id` (u32), `method`, `path`, `headers` (objet), `body` (`"none"` \| `"stream"`) | `path` inclut la query ; préfixe `/p/<slug>` accepté |
| `res` | hôte → openedbot | `id`, `status`, `headers` | |
| `end` | les deux | `id` | fin du corps (requête ou réponse) |
| `err` | les deux | `id`, `code`, `message`, `stage` (`before_dispatch` \| `after_dispatch`) | `before_dispatch` = jamais émis vers le gateway → openedbot classe `not_sent` ; sinon `ambiguous` |
| `cancel` | les deux | `id` | annule un flux en vol |
| `ping` / `pong` | les deux | aucun | applicatif, en plus des pings WebSocket |

Avant chaque session, le connecteur attend jusqu’à 15 s la réponse de l’opérateur à `GET /capabilities` (essais espacés de 500 ms, chaque réponse bornée à 5 s dans ce budget global), puis envoie un `hello` sans features si le délai expire. Dès que l’opérateur annonce ses features, il envoie `capabilities` sur le même WebSocket : aucune reconnexion, aucune interruption des requêtes en cours et aucun incident `link` provoqué par cette récupération. Ensuite, tant que la session dure, il relit l’opérateur toutes les 5 min et renvoie `capabilities` seulement si la liste a changé (par exemple `auto_upgrade` activé ou désactivé) ; une lecture qui échoue garde la dernière liste. Un échec d’écriture est réessayé tant que la session reste ouverte ; la récupération des véritables pertes réseau reste assurée par la boucle de connexion.

Pendant une session, le connecteur interroge aussi l’opérateur toutes les 5 s sur `GET /inventory/fingerprint` (socket locale, jamais relayée) : une empreinte des noms, tailles, modes et dates des fichiers qui font l’inventaire (`config.yaml`, `.env`, `mcp-tokens/*`, `SKILL.md`, racine et profils, plus la config gérée), calculée en Go sans lire aucun contenu ni démarrer d’interpréteur. Une empreinte qui bouge vide aussi le cache de lecture de l’opérateur : tout le cache si la part de la racine a bougé (son `HERMES_HOME` ou la config gérée), l’inventaire des profils seulement si seuls des profils ont bougé (la préparation d’un nouveau bot n’oblige plus à relire à froid les lectures de la racine). Le connecteur envoie ensuite `inventory.changed` si `link.context.accepts` la nomme. Un opérateur qui ne sert pas la route (404) arrête la sonde.

Déployer le support de `capabilities` dans l’API openedbot avant le nouveau connecteur. Une ancienne API ignore cette trame : elle ne reçoit alors les capacités qu’au prochain `hello` lors d’une reconnexion naturelle. La trame ne change ni l’identité du lien, ni sa date de connexion, ni les événements de remplacement.

Trames **binaires** : `[u32 BE id][bytes]`, un fragment de corps pour le flux
`id`. Pour une réponse SSE, un fragment par événement.

`id` est un compteur `uint32` par connexion, alloué côté openedbot.

### En-têtes

Vers l'hôte : `Accept`, `Cache-Control`, `Content-Type`, `Idempotency-Key`, `Last-Event-ID`, `traceparent`. `Cache-Control: no-cache` sur `GET /hermes-setup/usage` demande une sonde neuve à l'opérateur au lieu de sa lecture en cache (une minute).

`traceparent` ([W3C Trace Context](https://www.w3.org/TR/trace-context/), version `00`) est facultatif dans les deux sens. openedbot le pose sur chaque requête d'un run : le trace-id est l'identifiant du run sans ses tirets, le span-id change à chaque requête. Un hôte qui le connaît inscrit une ligne `relay <MÉTHODE> <chemin sans query> trace=<trace-id> span=<span-id>` dans son journal, une fois la route admise par l'allowlist, et transmet la valeur telle quelle au gateway (pas à l'opérateur). Une valeur mal formée, ou deux en-têtes `traceparent` dans la même trame, sont écartés sans erreur : ni relayés, ni journalisés. Un hôte plus ancien l'écarte comme tout en-tête hors de cette liste, et un openedbot plus ancien ne l'envoie pas : dans les deux cas la requête est servie à l'identique.
Jamais `Authorization`, `Cookie`, `Host` : l'hôte les retire s'ils arrivent et
ajoute lui-même `Authorization: Bearer <API_SERVER_KEY>` (lu depuis
`$CREDENTIALS_DIRECTORY/runtime.env`). Cible fixe `http://127.0.0.1:8642`.

Vers openedbot : `Content-Type`, `Retry-After`.

### Bornes

- 64 requêtes en vol par lien ; au-delà → `err` `LINK_BUSY` `before_dispatch`.
- corps de requête ≤ 1 MiB ; réponse ≤ 4 MiB (`MAX_HERMES_STREAM_BYTES`) ;
  dépassement → `err` `HERMES_PROTOCOL_LIMIT` sur cette seule requête (émis par
  l'hôte, ou par openedbot qui y ajoute un `cancel`) : le lien reste ouvert
  et les autres requêtes en vol continuent. La fermeture 1009 est réservée à
  un message WebSocket de plus de 4 MiB + 4 octets, ou à un hôte qui continue
  d'émettre plus de 8 MiB pour une réponse déjà abandonnée.
- `req` → premier `res` : 60 s, sauf `/v1/runs/{id}/events` ; flux `events`
  inactif : 15 min.
- une connexion par runtime : la plus récente gagne, l'ancienne est fermée
  4001 `LINK_REPLACED` et ses requêtes en vol reçoivent `err after_dispatch`.

### Borne des features

`hello.features` et `capabilities.features` portent au plus **64** noms, chacun
`^[a-z0-9_]{1,64}$`. C'est la borne de l'API, et elle l'annonce à l'hôte dès
la liaison, dans `link.context` :

```json
{"t":"link.context","environment":"prod","openedbot":"https://openedbot.app","limits":{"features":64}}
```

Avant ce champ, toute API refusait un `hello` de plus de **16** noms par une
fermeture 4401, que l'hôte compte comme un refus d'authentification (dix de
suite, puis un essai toutes les 30 minutes). Seize reste la borne de l'hôte tant
qu'aucune autre ne lui a été annoncée (`DefaultMaxFeatures`, à ne jamais
relever) : un hôte à jour face à une API plus ancienne, ou à son tout premier
`hello`, ne dépasse donc jamais ce que cette API accepte.

Règles de l'hôte (`internal/connector`) :

- **Jamais plus de noms que la borne en vigueur.** C'est celle du dernier
  `link.context` reçu ; une trame sans `limits` ramène à 16. Elle est persistée
  avec le contexte du lien dans `StateDirectory/link-context.json`
  (`limits.features`, ignoré tant que le `runtime_id` du fichier n'est pas celui
  du lien) et relue au démarrage : le premier `hello` d'un processus honore déjà
  la dernière borne annoncée. Un hôte qui n'en a encore jamais reçu envoie donc
  au plus 16 noms à sa première session ; la liste complète suit dès la
  suivante. Les features du lien comptent dans la borne.
- **Un ordre fixe.** Les features du lien (`creation_audit_v2`) d'abord, puis
  celles de l'opérateur dans l'ordre de `HostFeatures` (`frames.go`) :
  fournisseurs, toolsets et MCP, OAuth MCP et redémarrage du gateway, profils,
  inventaire de sessions, A2A, puis `model_context`, `provider_sdks` et enfin
  `skills_hub` (openedbot a sa propre table de repli pour le contexte).
  Un nom que ce connecteur ne connaît pas passe après les noms
  connus, par ordre alphabétique : l'ordre ne dépend jamais de celui de
  l'opérateur. Quand la borne est plus petite que la liste, la coupe prend la
  fin, et le journal nomme ce qu'elle retire (`hello capped at 16 feature names:
  dropped …`).
- **`capabilities` suit la même borne et le même ordre**, sans les features du
  lien, avec la borne en vigueur au moment de l'envoi.
- **Un repli.** Une session qui s'achève par une fermeture 4401 sans avoir reçu
  une seule trame, après un `hello` de plus de 16 noms, oublie la borne annoncée :
  l'API derrière ce nom a pu revenir en arrière, ou une instance plus ancienne
  répond. Le `hello` suivant tient en 16 noms et le lien repart au lieu de
  s'enliser dans les refus.

Pourquoi un champ de `link.context` plutôt qu'une trame : `DecodeText` lit les
trames avec `json.Unmarshal`, sans `DisallowUnknownFields`. Un hôte plus ancien
ignore donc `limits`, comme il ignore déjà `latestVersion` et `minimumVersion`,
alors qu'une trame nouvelle aurait fini dans son journal en `ignoring frame:
unknown frame type`.

**Ordre de déploiement : l'API d'abord, les hôtes ensuite.** Une API qui accepte
64 noms accepte aussi les hôtes anciens (16 noms au plus) ; un hôte à jour face à
une API qui n'a pas encore été mise à jour reste à 16. Une feature de plus se
déclare dans `LinkFeatures` ou `HostFeatures` à sa place dans la priorité, et la
suite de tests le garde : le vocabulaire complet de l'hôte est un vecteur
partagé (« hello with every feature name a host can announce »), décodé par
l'API comme par l'hôte, donc un hôte qui dépasse la borne de l'API casse un test
des deux côtés ; `internal/operator` vérifie en plus que chaque nom annoncé par
l'opérateur y figure, et que le `hello` le plus large tient dans les 16 noms par
défaut : au-delà, une API qui n'annonce pas de borne perd la fin de la liste, et
le test oblige à le reconnaître.

### Codes de fermeture

| Code | Sens |
|---|---|
| 1009 | message WebSocket de plus de 4 MiB + 4 octets, ou hôte qui émet plus de 8 MiB pour une réponse déjà abandonnée (une réponse trop grande échoue seule, sans fermer le lien) |
| 4001 | `LINK_REPLACED` : une connexion plus récente a pris le relais |
| 4003 | `LINK_PROBE_FAILED` : la sonde d'enrôlement a échoué (aucune ligne créée, ticket réutilisable jusqu'à son TTL) |
| 4004 | `LINK_REVOKED` : le runtime a été révoqué côté openedbot |
| 4005 | `LINK_RECONNECT_REQUESTED` : le ping WebSocket d'openedbot est resté sans pong, la session est raccrochée ; ce n'est pas un refus |
| 4401 | authentification refusée (ticket/jeton invalide, `hello` absent) |

## Allowlist

Méthode + expression de chemin, identiques dans les deux dépôts. Tout autre
chemin → `err 403 HERMES_LINK_PATH_FORBIDDEN before_dispatch`, sans toucher le
loopback.

```
GET  /health
GET  /v1/capabilities
GET  /v1/models
GET  /v1/toolsets
GET  /v1/skills
GET  /api/model/options
GET  /api/mcp/servers
POST /api/sessions
GET  /api/sessions/{id}
GET  /api/sessions/{id}/messages
DELETE /api/sessions/{id}
POST /v1/runs
GET  /v1/runs/{id}
GET  /v1/runs/{id}/events
POST /v1/runs/{id}/stop
POST /v1/runs/{id}/steer
POST /v1/runs/{id}/approval
```

`GET /api/sessions/{id}/messages` est une lecture seule du transcript Hermes.
openedbot l'utilise à la fin d'un run pour relire les appels d'outil Todo
et projeter le plan d'exécution affiché dans le fil. Les arguments Todo ne
sont pas garantis dans les événements SSE ; cette lecture ne doit donc pas
être remplacée par une inférence côté connecteur. Le connecteur relaie la
réponse Hermes sans lui ajouter d'état.

`DELETE /api/sessions/{id}` est la seule écriture destructive que le lien
porte vers le gateway. openedbot l'appelle quand l'opérateur purge un bot
qu'il avait mis à la corbeille : la session nommée `openedbot:<org>:<thread>` et son
transcript disparaissent du runtime. Le connecteur ne peut pas viser autre
chose (openedbot ne connaît aucun autre identifiant de session) et cette
route ne touche ni le profil, ni un fichier, ni l'hôte. Un runtime dont le
connecteur est antérieur à cette entrée refuse la route en
`403 HERMES_LINK_PATH_FORBIDDEN` ; côté SaaS la purge le dit à l'opérateur au
lieu de prétendre avoir effacé.

`{id}` n'a pas la même grammaire pour une session que pour un run : un
identifiant de session porte des deux-points (`openedbot:<org>:<thread>`), que le
chemin écrit `%3A`. L'allowlist les admet, et eux seuls : `%2F`, `%2E` et un
`%` nu restent refusés, pour qu'aucun `/` ni `..` ne se faufile en pourcentage
jusqu'au gateway qui le décoderait.

Routes **hôte** (servies par le connecteur, jamais dispatchées au gateway) :

```
GET    /hermes-setup/capabilities
GET    /hermes-setup/usage
GET    /hermes-setup/model-context
GET    /hermes-setup/provider-sdks
POST   /hermes-setup/providers/{provider}/credentials
POST   /hermes-setup/providers/{provider}/oauth
GET    /hermes-setup/providers/{provider}/oauth/{session}
DELETE /hermes-setup/providers/{provider}/oauth/{session}
GET    /hermes-setup/toolsets
POST   /hermes-setup/toolsets/{toolset}
GET    /hermes-setup/skills
GET    /hermes-setup/mcp/servers
POST   /hermes-setup/mcp/servers
DELETE /hermes-setup/mcp/servers/{server}
POST   /hermes-setup/mcp/catalog/{entry}
POST   /hermes-setup/mcp/servers/{server}/oauth
GET    /hermes-setup/mcp/servers/{server}/oauth/{session}
POST   /hermes-setup/mcp/servers/{server}/oauth/callback
DELETE /hermes-setup/mcp/servers/{server}/oauth/{session}
GET    /hermes-setup/gateway
POST   /hermes-setup/gateway/restart
GET    /hermes-setup/gateway/restart/{job}
GET    /hermes-setup/profiles
POST   /hermes-setup/profiles
DELETE /hermes-setup/profiles/{slug}
POST   /hermes-setup/profiles/{slug}/toolsets/{toolset}
POST   /hermes-setup/profiles/{slug}/toolsets
GET    /hermes-setup/profiles/{slug}/memory
POST   /hermes-setup/profiles/{slug}/memory
POST   /hermes-setup/profiles/{slug}/model
POST   /hermes-setup/profiles/models
GET    /hermes-setup/profiles/{slug}/approval-policy
PUT    /hermes-setup/profiles/{slug}/approval-policy
POST   /hermes-setup/profiles/{slug}/mcp/servers/{server}
DELETE /hermes-setup/profiles/{slug}/mcp/servers/{server}
POST   /hermes-setup/profiles/{slug}/skills/{skill}
POST   /hermes-setup/profiles/{slug}/bundled-skills
POST   /hermes-setup/profiles/{slug}/providers/{provider}/credentials
DELETE /hermes-setup/profiles/{slug}/providers/{provider}/credentials
POST   /hermes-setup/skills/hub/search
POST   /hermes-setup/skills/hub/inspect
POST   /hermes-setup/profiles/{slug}/skills/hub/scan
POST   /hermes-setup/profiles/{slug}/skills/hub/install
GET    /hermes-setup/profiles/{slug}/skills/hub/operations/{a}-{b}-{c}-{d}-{e}
DELETE /hermes-setup/profiles/{slug}/skills/{skill}
GET    /hermes-setup/profiles/{slug}/avatar
GET    /hermes-setup/sessions-inventory
GET    /hermes-setup/workspace/files/{file}
GET    /hermes-setup/a2a/agent-card
GET    /hermes-setup/a2a/audit
GET    /hermes-setup/a2a/peers
POST   /hermes-setup/a2a/peers/{peer}/trust
POST   /hermes-setup/a2a/peers/{peer}/token
DELETE /hermes-setup/a2a/peers/{peer}/token
```

`GET /hermes-setup/provider-sdks` indique si le Python du gateway peut importer
chaque SDK fournisseur épinglé. La route est en lecture seule et la feature
`provider_sdks` n'est annoncée que lorsque la sonde est configurée.

openedbot connecte **un** compte par fournisseur : quand une session OAuth aboutit,
l'opérateur retire du pool `hermes auth` les autres logins de ce fournisseur
(`hermes auth remove <provider> <label>`, tous sauf le plus récent). Mesuré
le 05-09 : deux logins épuisés d'un ancien compte restés devant le nouveau
faisaient retenter l'ancien compte à chaque heure (un 429 par rotation) et
la sonde `/hermes-setup/usage` rendait ce compte à 100 %. La sonde lit
d'ailleurs le credential que le gateway sert (`peek()` du pool), jamais le
premier de la liste.

Ce login aboutit dans le magasin RACINE (`auth.json` du `HERMES_HOME`). En
amont, un profil nommé ne lit la racine que s'il n'a aucun login à lui pour
ce fournisseur (`read_credential_pool`, `_load_provider_state` dans
`hermes_cli/auth.py`). Pour les fournisseurs à refresh token à usage unique
(`anthropic`, `openai-codex`, `xai-oauth`, `nous`, la liste
`SINGLE_USE_REFRESH_POOL_PROVIDERS` de `hermes_cli/auth_oauth_grants.py`),
l'opérateur fait donc, après le login, retirer par la sonde
(`profile-oauth-adopt-root`) l'état OAuth propre de ce fournisseur dans
chaque profil nommé (lignes OAuth du pool et bloc `providers.<id>` entier,
même sans refresh token, puisque l'amont le préfère dès qu'il existe), clés
API conservées, puis relit chaque magasin. Mesuré le 24-10 : un profil qui
s'était connecté seul à xAI gardait un refresh token révoqué
(`invalid_grant`), et chaque reconnexion depuis la console laissait son bot
en échec.

Ce retrait n'a lieu que si chaque login OAuth du profil (lignes du pool, bloc
`providers.<id>`, fichier `.anthropic_oauth.json`) est prouvé sans perte :
soit mort (aucun refresh token, ce que laisse la quarantaine amont, ou ligne
du pool en `last_status: dead` ou avec un `last_error_reason` terminal de
`_TERMINAL_AUTH_REASONS` dans `agent/credential_pool.py`, comme
`invalid_grant` ou `refresh_token_reused`, ou encore même refresh token
qu'une ligne morte du profil), soit au compte de la racine (même identité
`chatgpt_account_id`, `sub` ou `email` lue sans vérification dans le jeton
JWT, comme `_oauth_identity` en amont), soit de sa lignée quand l'identité
manque d'un côté (même `id` de ligne copié, même refresh ou access token,
comme `_find_root_counterpart`). Deux identités connues et différentes
l'emportent sur un `id` copié : l'amont réécrit la ligne `device_code` par
source, un clone garde donc l'`id` de la racine même après une reconnexion
sur un autre compte. Un `last_auth_error` seul ne prouve rien : un login
ultérieur réécrit les jetons et laisse ce marqueur. Sinon le profil peut
détenir le seul login vivant d'un autre compte (`hermes -p work auth add
xai-oauth`) : rien n'y est touché.

La réponse trie chaque profil touché : `profiles` (lit désormais le login
racine, prouvé à la relecture), `ownApiKey` (garde sa propre clé API pour ce
fournisseur ; l'amont lui donne alors sa propre tranche du pool, il ne lit
donc pas la racine et n'est jamais compté comme adopté ; la session reste
`connected`, car c'est une clé par bot voulue), `independent` (garde un login
qui peut être celui d'un autre compte vivant, laissé tel quel, jamais compté
comme adopté ; la session reste `connected` et l'opérateur journalise leur
nombre, jamais un jeton) et `refused` (`{profile,
code}` : `PROFILE_AUTH_UNREADABLE` pour un magasin illisible,
`PROFILE_AUTH_KEPT` pour un login OAuth encore présent après l'écriture). Un
`auth.json` de profil qui est un lien vers la racine est sauté ; un lien vers
un AUTRE magasin n'est jamais écrit au travers (il est partagé) : s'il porte
un login indépendant, le profil est rendu en `independent`, sinon un login
OAuth de ce fournisseur le rend en `PROFILE_AUTH_KEPT`, puisque l'amont le lit
comme le magasin propre du profil. Un
magasin illisible n'empêche pas de traiter les autres profils. Tout refus
fait échouer la session (`failed`, jamais `connected`) avec un message qui
nomme les profils et sépare les deux causes ; une sonde en échec (délai,
plantage) a son propre message.

`provider ~ ^[a-z0-9][a-z0-9_-]{0,63}$`, `session` et `job` `~ [A-Za-z0-9._~-]{1,128}`,
`toolset ~ ^[a-z0-9][a-z0-9_]{0,63}$`,
`skill ~ ^[a-z0-9][a-z0-9_-]{0,63}$` (comme un toolset, plus le tiret : `hermes-agent`),
`server` et `entry` `~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`,
`slug` de profil `~ ^[a-z0-9][a-z0-9_-]{0,62}$` (même grammaire que le préfixe `/p/<slug>`),
`peer` A2A `~ ^[a-z0-9][a-z0-9._-]{0,63}$`.
`provider` et `model` du bloc profil `~ ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$` (ids avec points, deux-points, barres).

Chaque segment variable est une classe **bornée**. Aucune route hôte n'admet
`.`, `*` ni `+` : un chemin de fichier ou une commande ne peut pas s'y écrire,
dans aucun sens.

Préfixe optionnel `/p/{slug}` avec `slug ~ ^[a-z0-9][a-z0-9_-]{0,62}$`. Sur
les routes hôte il est accepté et ignoré : un credential vaut pour tout le
runtime.

## Fournisseurs par le lien

Sur l'hôte, `hermes-operator.service` (root, socket Unix
`/run/hermes-operator/operator.sock`, 0660 root:hermes) est le seul
processus du lien qui exécute la CLI `hermes`, sous l'utilisateur de service :
`hermes auth add` (clé API sur stdin, ou connexion par appareil),
`hermes auth list` et `hermes auth remove` (un seul compte par fournisseur, voir
ci-dessus), `hermes -p <slug> auth add` (credential d'un profil) et
`hermes tools enable|disable`, avec ou sans `-p <slug>`, ainsi que
`hermes -p <slug> plugins enable openedbot_approval_policy`. Ses autres
programmes sont tout aussi fixes : le redémarrage du gateway (voir
« Redémarrage du gateway par le lien ») et cinq programmes Python
**embarqués** (usage, inventaire, OAuth MCP, politiques A2A et d'approbation). La sonde d'usage
est passée sur stdin au Python du venv sous `hermes` avec les seuls slugs
fixés `anthropic`, `openai-codex`, `openrouter` et `xai-oauth` (ce dernier lu
chez `cli-chat-proxy.grok.com`, Hermes n'en lisant pas). La liste complète est celle
de « Invariants ». Aucun shell, chemin, URL, credential ou argument libre ne
peut traverser le lien. Le connecteur tourne
sous l'unique compte système `hermes`, mais son unité masque les données du
runtime et le répertoire utilisateur ; réciproquement, l'unité gateway masque
l'état connector et le socket opérateur. Il relaie ces routes fixes et rien
d'autre. Il annonce
`provider_management` et `provider_usage` dans `hello` seulement si le socket
existe.

Corps et réponses (JSON, `Content-Type: application/json`) :

| Route | Corps | Réponse |
|---|---|---|
| `GET /hermes-setup/capabilities` | aucun | 200 `{"features": ["provider_management", "provider_usage"]}` ; un hôte sans opérateur répond `err HERMES_OPERATOR_UNAVAILABLE` |
| `GET /hermes-setup/usage` | aucun | aperçu de quotas borné ci-dessous ; 502 `USAGE_PROBE_FAILED` ou 504 `USAGE_PROBE_TIMEOUT` |
| `POST …/credentials` | `{"apiKey": string, "label"?: string}` | 200 `{"provider", "label", "verification": "confirmed" \| "denied" \| "unverified", "detail": string \| null}` ; 409 `CREDENTIAL_IN_PROGRESS` si un ajout est déjà en cours (l'opérateur n'exécute qu'un `hermes auth add` à la fois) |
| `POST …/oauth` | `{}` ou vide | 200 session ; 409 `OAUTH_IN_PROGRESS` si une session `starting`/`pending` existe déjà pour ce fournisseur (elle est renvoyée dans `session`) |
| `GET …/oauth/{session}` | aucun | 200 session ; 404 `OAUTH_SESSION_NOT_FOUND` |
| `DELETE …/oauth/{session}` | aucun | 204 ; 404 |

Session : `{"sessionId", "provider", "status": "starting" | "pending" |
"connected" | "failed" | "cancelled", "verificationUri": string | null,
"userCode": string | null, "error": string | null, "expiresAt": RFC 3339}`.
Une session expire 15 min après son départ ; `connected` n'est rendu
qu'après relecture de `/api/model/options` sur le loopback (`authenticated`
vrai pour ce fournisseur), jamais sur la seule sortie de la CLI.

Erreurs : `{"error": {"code", "message"}}`, HTTP 400 (`PROVIDER_INVALID`,
`API_KEY_INVALID`), 404, 409, 502 (`RUNTIME_CATALOGUE_UNREADABLE`). Si le
socket de l'opérateur ne répond pas, le connecteur émet `err`
`HERMES_OPERATOR_UNAVAILABLE` `before_dispatch` : rien n'a atteint l'hôte.

La clé API voyage : formulaire openedbot → HTTPS → API openedbot
(mémoire, jamais en base ni en journal) → WSS → connecteur → socket →
stdin de `hermes auth add --type api-key`. Elle n'apparaît dans aucun argv,
aucun journal, aucune trame relue.

Après chaque `credentials add`, `credentials remove` ou OAuth device-code,
l'opérateur compare le `.env` racine avant/après l'appel Hermes et reproduit
chaque ajout, modification ou suppression de clé fournisseur dans le `.env`
de tous les profils nommés présents sous `HERMES_HOME/profiles/*/`. Les copies
sont atomiques, en mode `0600`, propriétaires de `hermes`. `API_SERVER_KEY` est
exclue de ce miroir : un profil nommé doit garder son propre bearer. Une clé
posée **en propre** sur un profil (`POST /hermes-setup/profiles/{slug}/providers/{provider}/credentials`)
est marquée (`# openedbot:profile-own` et fichier `.env.openedbot-own`) : le miroir ne
l'écrase jamais. Le même miroir est effectué par `edge-setup credentials
add|remove|login` depuis la console ; une erreur de miroir rend l'opération
non confirmée.

## Quotas fournisseur

`GET /hermes-setup/usage` démarre au plus une sonde partagée par minute (cache
60 s, single-flight), avec une limite totale de 25 s. Elle demande à Hermes
`agent.account_usage.fetch_account_usage(provider)` pour les seuls fournisseurs
pris en charge et renvoie un JSON ≤ 256 KiB. Une erreur d'un fournisseur est
une entrée `unavailable`, jamais le texte d'une erreur upstream. Un catalogue
illisible sonde les trois fournisseurs supportés ; un fournisseur authentifié
mais sans fetcher (xAI/Grok, Gemini…) est `unsupported`.

```json
{
  "fetchedAt": "2026-09-02T09:41:12Z",
  "providers": [{
    "provider": "anthropic",
    "source": "oauth_usage_api",
    "plan": "max",
    "windows": [{"label": "Current week", "usedPercent": 97, "resetAt": "2026-09-04T00:00:00Z", "detail": null}],
    "details": [],
    "unavailableReason": null
  }]
}
```

`source` vaut exactement `oauth_usage_api`, `usage_api`, `credits_api`,
`unsupported` ou `unavailable`. Chaque fenêtre est bornée à huit, chaque label
à 64 caractères, chaque texte à 200 et `usedPercent` est normalisé entre 0 et
100. Les timestamps valides sont rendus en RFC 3339 UTC.

## Toolsets et MCP par le lien

Ces six routes existent pour que l'opérateur administre la surface de capacités
de son runtime depuis openedbot au lieu d'une console sur l'hôte. Elles
sont annoncées dans `hello` et dans `/v1/capabilities` par
`toolset_management` et `mcp_management`. Un opérateur qui ne les sert pas ne
les annonce pas, et openedbot n'affiche alors aucun bouton : la page
retrouve son régime de lecture.

### Toolsets

`GET /hermes-setup/toolsets` rend `{platform, settable}`. La liste ne double
pas `/v1/toolsets` (qui dit déjà l'état de chaque toolset) : elle dit ce que
cet hôte accepte d'ÉCRIRE sur la plateforme `api_server`. Un toolset restreint
à une autre plateforme est laissé tomber en silence par l'écriture amont ; sans
cette liste, l'application offrirait une bascule dont le succès serait faux.

La réponse porte aussi `availability`, un tableau borné (256 lignes) de
`{name, available, reason}`, une ligne par toolset que la plateforme liste.
`available` est calculé par la fonction que Hermes utilise pour décider ce
qu'il annonce au modèle (`is_toolset_available` du registre d'outils : au moins
un outil dont le `check_fn` passe), pas par l'expansion statique de
`GET /v1/toolsets`, qui garde un toolset `browser` « prêt » sans Chromium.
Valeurs : `true`, `false`, ou `null` quand ce n'est pas mesuré (toolset inconnu
du registre, comme un composite ou un plugin ; Hermes sans cette fonction ; un
contrôle qui a levé). `reason` n'est renseigné que si `available` vaut `false`,
et vient d'un jeu fermé : `credentials_missing` (une variable exigée par les
outils du toolset est vide) ou `check_failed` (le contrôle amont refuse, sans
que l'hôte sache dire pourquoi). Jamais un nom de variable, un chemin ou une
valeur. Le contrôle est lu sur le `HERMES_HOME` racine : il vaut pour l'hôte,
pas pour la configuration propre à un profil. Ce n'est ni un nouveau verbe ni
une nouvelle capacité : le champ voyage sous `toolset_management`, et un hôte
plus ancien l'omet. **Un champ absent se lit « inconnu », jamais
« disponible ».**

`POST /hermes-setup/toolsets/{toolset}` prend `{"enabled": bool}` et exécute
`hermes tools enable|disable <toolset> --platform api_server` sous
l'utilisateur de service. La plateforme est `api_server` et jamais autre chose :
c'est celle que le gateway lit et que tout run openedbot utilise ; le
Dashboard Hermes, lui, écrit `cli` par défaut, ce qui n'a aucun effet observable
ici.

La réponse porte `{name, platform, enabled, requested, applied}`. **`enabled`
est relu sur `/v1/toolsets` après l'écriture**, jamais déduit de la commande :
`hermes tools` imprime ses refus en sortant quand même en `0`, et
`agent.disabled_toolsets` peut annuler une activation. `applied: false` est donc
un résultat normal du contrat, pas une erreur de transport.

Sur un profil, quand la relecture contredit la demande, l'opérateur passe par
`agent.disabled_toolsets` du profil (programme d'inventaire, verbe
`profile-toolset-suppress`), puis relit. Ce réglage s'applique en dernier chez
Hermes. Cas observé : une liste `api_server` vide réactive `x_search` dès que
des identifiants xAI existent. La levée d'une suppression ne retire jamais un
nom que la racine supprime aussi : ce choix appartient à l'opérateur de l'hôte.

Les toolsets de `pins.AlwaysForbiddenToolsets` (`cronjob`, `delegation`) sont
refusés en `403 TOOLSET_FORBIDDEN` à l'activation, racine ou profil. `memory`
et `session_search` (`pins.ProfileRestrictedToolsets`) restent refusés sur
`POST /hermes-setup/toolsets/{toolset}` (racine partagée) et sont acceptés sur
`POST /hermes-setup/profiles/{slug}/toolsets/{toolset}` : le profil a son
propre `HERMES_HOME`. Les désactiver reste toujours possible. La scission est
la jumelle de `runtime-contract.ts` côté openedbot.

`POST /hermes-setup/profiles/{slug}/toolsets` (capacité
`profile_toolsets_batch`) écrit plusieurs toolsets d'un même profil en une
requête : `{"toolsets": {"web": true, "browser": false}}`, 1 à 32 noms. Les
garde-fous de la route unitaire valent pour tout le lot avant toute écriture
(un nom refusé refuse le lot). Les deux sens s'écrivent ensuite dans un seul
processus Python lancé dans le dossier du profil (`profile_toolsets_apply.py`,
`HERMES_HOME` posé avant l'import de Hermes), avec la fonction amont
qu'appelle `hermes tools enable|disable`. Le programme refuse d'écrire si
Hermes désigne un autre `config.yaml` que celui du profil : l'écriture amont
irait sinon sur la racine. S'il échoue, on retombe sur un appel CLI par sens
(`tools enable a b`, `tools disable c`), qui démarre chacun Hermes. L'inventaire
du profil est relu une seule fois pour tout le lot ; un nom qui n'a pas bougé
reçoit le repli de suppression de la route unitaire, puis une dernière
relecture. La réponse donne un état par nom, `applied` compris. Chaque lot
inscrit au journal la durée de ses étapes (liste réglable, écriture, relecture).

Une écriture qui ne touche que le dossier d'un profil (`profile-create`,
toolsets, skills, mémoire, modèle) n'invalide que l'inventaire des profils
dans le cache de lecture de l'opérateur. Les lectures de la racine
(`toolsets`, `skills`, `mcp-inventory`) restent en cache, même lancées avant
l'écriture. `profile-delete` et `profile-oauth-adopt-root` vident tout.

### Skills

`GET /hermes-setup/skills` (capacité `skills_inventory`) rend la liste des
skills de la racine au format de `/v1/skills` :
`{"object":"list","data":[{name, description, category}]}`, bornée à 1024.
C'est un repli : Hermes 0.21.3 à 0.22.6 répond 500 sur `/v1/skills` (il passe
`include_editorial` à une fonction qui ne le prend pas), et l'opérateur lit la
même liste par la sonde Python, sans cet argument. openedbot ne l'appelle que
si `/v1/skills` a échoué et que l'hôte annonce la capacité ; si le repli échoue
aussi, l'erreur d'origine reste affichée, jamais une liste vide. Lecture seule,
mise en cache comme les autres lectures d'inventaire et vidée quand
l'empreinte bouge.

### MCP

`GET /hermes-setup/mcp/servers` rend les serveurs configurés et le catalogue
approuvé présent sur l'hôte. Aucun champ ne porte de secret : `endpoint` est une
localisation, une commande stdio est nommée sans son argv, et l'environnement
est rendu par **clé** : la valeur d'un `env` MCP est couramment un jeton.

`POST /hermes-setup/mcp/servers` ajoute un serveur **https** : `{name, url,
auth, token?, replace?}`. Un corps qui porte `command` est refusé en
`400 STDIO_REFUSED` plutôt qu'ignoré. Ajouter un serveur en commande locale,
c'est nommer un exécutable et son argv, et le lien ne porte aucun exécutable
vers l'hôte ; les serveurs en commande locale arrivent par le catalogue.

`POST /hermes-setup/mcp/catalog/{entry}` installe une entrée du catalogue
approuvé, avec `{env}`. `entry` est validé contre le catalogue réellement
présent sur l'hôte, et `env` n'accepte que les variables que le manifeste
**déclare** : une clé que l'appelant invente est refusée en `400 ENV_UNKNOWN`,
parce que c'est le seul endroit où un nom choisi à distance atteindrait le
fichier `.env` de l'hôte.

`DELETE /hermes-setup/mcp/servers/{server}` retire le serveur de la
configuration et de la plateforme `api_server`, puis l'état OAuth de la racine
(jeton, enregistrement du client, métadonnées), comme `hermes mcp remove` :
200 `{"name", "tokensRemoved": bool}`. `tokensRemoved: false` dit qu'un fichier
de jeton a survécu : le serveur est retiré, mais un identifiant reste sur le
disque.

### OAuth MCP par le lien

Un serveur `auth: oauth` (Notion, Linear, Figma, Atlassian… : la moitié du
catalogue approuvé) est **inerte** tant qu'un navigateur ne l'a pas autorisé :
le client MCP amont refuse d'ouvrir une session sans jeton, et le gateway ne
liste jamais ses outils. `install_entry` amont n'écrit que le marqueur
`auth: oauth` et laisse « le navigateur à la première connexion » : un hôte
sans écran n'en a pas, et n'offre aucun port de retour à un fournisseur.

Le flux est celui du Dashboard Hermes (`POST /api/mcp/servers/{name}/auth`,
`GET /api/mcp/oauth/callback/{name}`), dont la jambe navigateur passe par
openedbot au lieu d'un serveur loopback :

| Route | Corps | Réponse |
|---|---|---|
| `POST …/{server}/oauth` | `{"redirectUri": string}` : l'URL de retour d'openedbot, `https://` ou un `http://` de loopback (développement) ; enregistrée telle quelle auprès du fournisseur, jamais composée ici | 200 session, en `pending` avec `authorizationUrl` dès que le programme l'a imprimée (au plus 60 s) ; 409 `MCP_OAUTH_IN_PROGRESS` avec la session en cours ; 503 `OAUTH_UNAVAILABLE` |
| `GET …/{server}/oauth/{session}` | aucun | 200 session ; 404 `OAUTH_SESSION_NOT_FOUND` |
| `POST …/{server}/oauth/callback` | `{"code", "state"}` ou `{"error"}` : ce que le fournisseur a renvoyé au navigateur. La route nomme le **serveur**, pas la session : l'URL de retour est enregistrée avant qu'une session existe | 200 session ; 404 si aucune autorisation n'attend ; 409 `OAUTH_CALLBACK_USED` |
| `DELETE …/{server}/oauth/{session}` | aucun | 204 ; 404 |

Session : `{"sessionId", "server", "status": "starting" | "pending" |
"connected" | "failed" | "cancelled", "authorizationUrl": string | null,
"error": string | null, "errorCode": string | null, "discoveredTools":
[string], "expiresAt": RFC 3339}`.

`state` est validé sur l'hôte, par le flux amont (`compare_digest`) ; un
callback dont le `state` ne correspond pas fait échouer l'autorisation, fermée.
La session ne passe `connected` que lorsque le programme a **relu un jeton sur
le disque** (`_oauth_tokens_present`) et listé les outils du serveur avec lui,
jamais sur le seul callback. Un succès sauvegarde l'entrée, la porte sur
`api_server`, et pose le marqueur « redémarrage en attente » ci-dessous. Un
échec restaure l'état OAuth précédent, comme le fait le Dashboard.

L'inventaire porte désormais `oauthTokenPresent` (booléen pour un serveur
`oauth`, `null` sinon) : un serveur enregistré sans jeton se lit comme ce qu'il
est, pas comme un serveur qui marche.

`errorCode` est un jeu fermé : `OAUTH_NO_TOKEN`, `OAUTH_TIMEOUT`,
`OAUTH_CALLBACK_INVALID`, `OAUTH_CANCELLED`, `OAUTH_REGISTRATION_REFUSED` (le
fournisseur refuse l'enregistrement dynamique : Figma exige un client
pré-enregistré), `OAUTH_UNSUPPORTED`, `OAUTH_FAILED`. Aucun texte amont ne
traverse.

### Redémarrage du gateway par le lien

Le gateway lit ses serveurs MCP **une fois, au démarrage**
(`discover_mcp_tools` amont) ; `/reload-mcp` est une commande de chat que les
runs `api_server` ne traversent pas, et aucune route `api_server` ne recharge.
Toute écriture MCP ci-dessus (ajout, installation, autorisation, retrait)
est donc invisible aux runs jusqu'au redémarrage de l'unité `hermes-gateway`.

Plutôt que de laisser un serveur « porté par la plateforme » ne rien porter,
le lien dit le fait et permet le geste :

| Route | Corps | Réponse |
|---|---|---|
| `GET /hermes-setup/gateway` | aucun | 200 `{"restartPending": bool, "pendingSince": RFC 3339 \| null, "activeSince": RFC 3339 \| null, "job": job \| null}` |
| `POST /hermes-setup/gateway/restart` | `{}` ou vide | 202 job ; 409 `GATEWAY_RESTART_IN_PROGRESS` avec le job en cours ; 503 `GATEWAY_RESTART_UNAVAILABLE`. Avec la feature `gateway_graceful_restart`, le redémarrage ne coupe aucun run : l'opérateur envoie `SIGUSR1` au processus principal du gateway (redémarrage drain-aware de Hermes), le gateway refuse les nouveaux runs en 503 `gateway_draining` (openedbot les remet en file, sans compter de tentative), laisse finir ceux en cours (jusqu'à `restart_after_turn_timeout`, 30 min), sort en 75 et systemd le relance. Le job reste à l'étape `restart` pendant ce drain, borné à 35 min, puis prouve `/health`. Un refus de connexion du gateway en cours de relance est rendu `before_dispatch` : rien n'a été envoyé. Sans la feature, `systemctl restart` interrompt les runs en cours. |
| `GET /hermes-setup/gateway/restart/{job}` | aucun | 200 job ; 404 `GATEWAY_RESTART_NOT_FOUND` |

Job : `{"jobId", "status": "running" | "ok" | "failed", "step": "restart" |
"health" | "done", "startedAt", "finishedAt": RFC 3339 | null, "error":
string | null, "expiresAt"}`.

`restartPending` vient d'un **marqueur** (`/run/hermes-operator/gateway-restart-pending`)
posé par la première écriture que le gateway n'a pas vue (écriture MCP ou
autorisation OAuth MCP, bascule MCP d'un profil, écriture d'un jeton de pair
A2A, ou `upgrade`, quand les directives de l'unité gateway changent alors que
des runs sont en cours : l'unité est prête, le gateway tourne encore sur
l'ancienne), et jamais d'une supposition : il est retiré quand un redémarrage
prouvé aboutit, ou quand `ActiveEnterTimestamp` de l'unité est postérieur au
marqueur : un opérateur qui a redémarré depuis la console n'est pas prié de
recommencer.

Un gateway récent réconcilie lui-même ses serveurs MCP avec la configuration
sur le disque, pour chaque profil servi, à chaque tour de maintenance (60 s,
`_mcp_config_reconciler` amont), et une session ouverte reprend ses outils
entre deux tours. L'hôte le lit dans ses sources installées, sans les importer
(`mcpLiveReload` du document des profils), et annonce alors la feature
`mcp_live_reload` : les écritures MCP (ajout, installation, retrait, autorisation
OAuth, bascule ou déconnexion d'un profil) ne posent plus le marqueur. Les
autres causes le posent toujours. Sans la feature, openedbot demande le
redémarrage comme avant.

Le marqueur vit dans le `RuntimeDirectory` de `hermes-operator.service`, qui
porte `RuntimeDirectoryPreserve=yes` : un arrêt ou un redémarrage de
l'opérateur (`upgrade` le redémarre toujours) ne l'efface pas. Seul un
redémarrage de la machine vide `/run`, et le gateway redémarre alors de toute
façon.

Le redémarrage est **le seul** que le lien porte. Il ne nomme rien : la route
est fixe, l'unité est `hermes-gateway` et rien d'autre, aucun argument n'est
lu. Il est **prouvé sur `/health`** (`step: health`), jamais sur le code de
sortie de `systemctl` : un `systemctl restart` qui réussit suivi d'un gateway
qui ne répond pas est un `failed` à l'étape `health`, et le marqueur reste. Un
seul redémarrage à la fois.

Jumeau console : `systemctl restart hermes-gateway`, puis `edge-setup
doctor`.

### Profils par le lien

`GET /hermes-setup/profiles` rend les profils nommés déjà présents sur l'hôte,
hors `default`, ainsi que `multiplex`, la valeur relue de
`gateway.multiplex_profiles`, et `mcpLiveReload` (présent et `true` seulement
quand le gateway installé réconcilie ses serveurs MCP à chaud). Aucun `.env`, aucune mémoire, aucune session ne
traverse le lien. Skills, toolsets et MCP portent seulement un nom et un état
activé. `GET /hermes-setup/profiles/{slug}/avatar` rend une image bornée.

Quand le programme d'inventaire est présent et que `multiplex` vaut `true`,
l'opérateur annonce `profile_management` et `profile_credentials`; il annonce aussi
`profile_capabilities` si son lecteur d'inventaire gateway est disponible. Il
relit la valeur au démarrage puis à chaque `GET /hermes-setup/capabilities`
(des appels simultanés partagent la même relecture); la lecture des profils
reste une lecture pure mise en cache et invalidée après chaque écriture.

Les lectures pures en cache (`toolsets`, `mcp-inventory`, `profiles`) vivent
une minute. Passé ce délai et pendant dix minutes encore, la lecture répond
aussitôt avec le document en cache et le relit en arrière-plan : rouvrir un
écran de la console ne paie plus une sonde à froid. Une écriture de
l'opérateur efface le cache et les lectures en cours, donc la relecture qui
prouve une écriture est toujours neuve.

| Route | Corps | Réponse / erreurs |
|---|---|---|
| `POST /hermes-setup/profiles` | `{"name", "displayName"?, "provider"?, "model"?, "bundledSkills"?: false}` | 201 `{"profile": <entrée relue>, "readBack"?: "profile", "bundledSkills"?: <état des skills livrées>}` ; 400 `PROFILE_INVALID` ou `BODY_INVALID` ; 409 `PROFILE_EXISTS` ; 503 `MULTIPLEX_OFF` ; 502 `PROFILE_ENV_REFUSED`, `PROFILE_CONFIG_REFUSED` ou `PROFILE_UNVERIFIED`. `provider` et `model` optionnels, bornés `[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}`, écrits ensemble dans le `config.yaml` du profil (`model.provider` / `model.default`). `readBack: "profile"` dit que la sonde de création a relu elle-même le profil écrit (listé sous ce nom, modèle demandé présent) : cette relecture ciblée remplace alors l'inventaire complet, qui coûtait une sonde à froid de plus. Sans la marque (hôte plus ancien, relecture non concluante), l'entrée vient de l'inventaire complet et openedbot le relit comme avant. `bundledSkills: false` désactive les skills livrées avec Hermes dans la même sonde que la création (un interpréteur de moins pour un nouveau bot) ; `true` est refusé (400 `BODY_INVALID`). L'état rendu a la forme de `POST …/bundled-skills` (`profile`, `requested`, `bundled`, `bundledEnabled`, `applied`) et n'apparaît que si la sonde l'a relu de façon cohérente pour ce profil : sans lui (désactivation en échec, hôte plus ancien qui ignore le champ), openedbot écrit les skills livrées par la route dédiée |
| `DELETE /hermes-setup/profiles/{slug}` | aucun | 204 ; 400 `PROFILE_INVALID` ; 404 `PROFILE_NOT_FOUND` ; 502 `PROFILE_UNVERIFIED` |
| `POST /hermes-setup/profiles/{slug}/model` | `{"provider", "model"}` | 200 `{"profile", "provider", "model"}` relus sur l'inventaire ; 400 `PROFILE_INVALID` ou `BODY_INVALID` ; 404 `PROFILE_NOT_FOUND` ; 502 `PROFILE_UNVERIFIED`. Annoncé sous `profile_capabilities`. Jumeau de `profiles.configure { model, provider }` : sous un profil multiplexé le gateway ignore le `provider` du run et lit `model.provider` dans le `config.yaml` du profil |
| `POST /hermes-setup/profiles/models` | `{"provider", "model", "profiles": [slug, ...]}` (1 à 64 noms) | 200 `{"provider", "model", "profiles": [{"profile", "provider", "model", "applied", "code"?}]}` : une seule écriture pour tous les profils, puis une seule relecture de l'inventaire ; `applied` est lu sur cet inventaire. Un profil refusé (`PROFILE_NOT_FOUND`, `PROFILE_INVALID`, `PROFILE_CONFIG_REFUSED`) porte son `code`, les autres s'appliquent. 400 `BODY_INVALID` ou `PROFILE_INVALID` sur le corps ; 502 `PROFILE_UNVERIFIED`. Annoncé par `profile_model_batch`, dernier nom en priorité : sans lui, openedbot écrit profil par profil |
| `GET /hermes-setup/profiles/{slug}/approval-policy` | aucun | 200 `{"mode", "pluginEnabled", "effective", "gateIdentity", "blockedTools"}` relus depuis le fichier fixe du plugin et la configuration du profil ; `effective` exige le plugin actif, le fichier valide et aucun redémarrage du gateway en attente. `gateIdentity` dit que le plugin installé sur ce profil est, octet pour octet, celui que porte le binaire, donc qu'il nomme et décrit chaque gate (voir « Identité des gates ») ; `blockedTools` liste les clés d'outil que le plugin bloque sans poser de gate. Un hôte plus ancien omet ces deux champs. `plugins.disabled` prévaut sur `plugins.enabled` ; 400 `PROFILE_INVALID` ; 502 `APPROVAL_POLICY_UNAVAILABLE`. Annoncé sous `approval_policy` seulement quand les deux verbes sont disponibles |
| `PUT /hermes-setup/profiles/{slug}/approval-policy` | `{"mode":"ask_writes"|"block_writes"|"off","blockedTools"?:["<clé d'outil>"]}` | 200 avec le même état relu ; 400 `PROFILE_INVALID` ou `BODY_INVALID` ; 502 `APPROVAL_POLICY_UNVERIFIED`. Sans `blockedTools`, la liste en place est gardée ; avec, elle est remplacée (au plus 64 clés distinctes, `^([a-z][a-z0-9_]{0,63}|mcp:<serveur>:<outil>)$`) et prouvée par la relecture. Pose le marqueur « restart pending » avant toute modification des fichiers du plugin ou de son activation. Les changements suivants du mode et de la liste sont lus à chaque appel et ne demandent pas de redémarrage |
| `POST /hermes-setup/profiles/{slug}/toolsets/{toolset}` | `{"enabled": bool}` | 200 `{"name", "profile", "platform", "enabled", "requested", "applied"}` ; 400 `PROFILE_INVALID`, `TOOLSET_INVALID` ou `BODY_INVALID` ; 403 `TOOLSET_FORBIDDEN` ; 404 `TOOLSET_NOT_SETTABLE` ; 409 `TOOLSET_IN_PROGRESS` ; 502 `CLI_REFUSED` ou `TOOLSET_UNVERIFIED` |
| `POST /hermes-setup/profiles/{slug}/toolsets` | `{"toolsets": {"<toolset>": bool}}`, 1 à 32 noms (feature `profile_toolsets_batch`) | 200 `{"profile", "platform", "toolsets": [{"name", "profile", "platform", "enabled", "requested", "applied"}]}` dans l'ordre des noms ; 400 `PROFILE_INVALID`, `TOOLSET_INVALID` ou `BODY_INVALID` ; 403 `TOOLSET_FORBIDDEN` ou `A2A_POLICY_UNAVAILABLE` ; 404 `TOOLSET_NOT_SETTABLE` ; 409 `TOOLSET_IN_PROGRESS` ; 502 `CLI_REFUSED` ou `TOOLSET_UNVERIFIED` |
| `POST /hermes-setup/profiles/{slug}/mcp/servers/{server}` | `{"enabled": bool}` | 200 `{"name", "profile", "platform", "enabled", "requested", "applied"}` ; 400 `PROFILE_INVALID`, `NAME_INVALID` ou `BODY_INVALID` ; 404 `PROFILE_NOT_FOUND` ou `MCP_SERVER_NOT_FOUND` ; 409 `MCP_IN_PROGRESS` ; 502 `PROFILE_CONFIG_REFUSED` ou `MCP_UNVERIFIED` |
| `DELETE /hermes-setup/profiles/{slug}/mcp/servers/{server}` | aucun | 200 `{"profile", "name", "removed", "tokensRemoved"}` ; 400 `PROFILE_INVALID` ou `NAME_INVALID` ; 404 `PROFILE_NOT_FOUND` ; 409 `MCP_IN_PROGRESS` ; 502 `PROFILE_CONFIG_REFUSED`. Déconnecte un bot : retire le serveur du `mcp_servers` du profil et de sa plateforme `api_server`, puis supprime l'état OAuth du serveur dans le home du profil. L'entrée racine, modèle des autres connexions, reste. Idempotent : un profil qui ne porte pas le serveur répond `removed: false` et perd quand même un jeton ou un enregistrement de client laissé par une autorisation ratée. Feature `mcp_profile_disconnect`, annoncée par un hôte qui multiplexe les profils. |
| `POST /hermes-setup/profiles/{slug}/skills/{skill}` | `{"enabled": bool}` | 200 `{"name", "profile", "platform", "enabled", "requested", "applied"}` ; `enabled` relu sur `profiles.skills[]` ; 400 `PROFILE_INVALID`, `SKILL_INVALID` ou `BODY_INVALID` ; 404 `PROFILE_NOT_FOUND` ou `SKILL_NOT_FOUND` ; 409 `SKILL_IN_PROGRESS` ; 502 `SKILL_UNVERIFIED`. La sonde écrit `disabled_skills` (et `skills.disabled`, la clé que hermes-agent lit) dans le `config.yaml` du profil. |
| `POST /hermes-setup/profiles/{slug}/bundled-skills` | `{"enabled": bool}` seulement | 200 `{"profile", "requested", "bundled", "bundledEnabled", "applied"}` ; `applied` vérifie l'état relu, les skills essentielles restent actives ; 400 `PROFILE_INVALID` ou `BODY_INVALID` ; 404 `PROFILE_NOT_FOUND` ; 409 `SKILL_IN_PROGRESS` ; 502 `PROFILE_CONFIG_REFUSED` ou `SKILL_UNVERIFIED`. Désactive ou réactive en une écriture toutes les skills indiquées par `.bundled_manifest` et présentes sur le profil. Les skills apprises ou installées depuis le hub ne changent pas. Feature `profile_bundled_skills`, annoncée avec `profile_capabilities`. |
| `POST /hermes-setup/profiles/{slug}/providers/{provider}/credentials` | `{"apiKey", "label"?}` | 200 `{"provider", "profile", "verification": "confirmed" \| "denied" \| "unverified"}` ; 400 `PROFILE_INVALID`, `PROVIDER_INVALID`, `API_KEY_INVALID` ; 409 `CREDENTIAL_IN_PROGRESS` ; 502 `CLI_REFUSED`, `PROFILE_ENV_REFUSED` ou `PROVIDER_UNKNOWN`. La clé voyage sur stdin ; la preuve est `/p/<slug>/api/model/options`. |
| `DELETE /hermes-setup/profiles/{slug}/providers/{provider}/credentials` | aucun | 200 `{"provider", "profile", "verification"}` ; mêmes gardes de slug. Retire la variable `key_env` du `.env` du profil et sa marque `openedbot:profile-own`. |

### Identité des gates

Le plugin d'approbation (`approval_policy_plugin/__init__.py`) nomme chaque
gate qu'il pose : il renvoie `rule_key = "openedbot/v1/<clé d'outil>"`, que Hermes
transmet en `pattern_key = "plugin_rule:openedbot/v1/<clé d'outil>"`. La clé est le
nom de l'outil natif (`write_file`, `patch`, `skill_manage`, `send_message`,
`execute_code`, `cronjob`) ou `mcp:<serveur>:<outil>`, le serveur étant lu
dans le registre d'outils de Hermes. Son message se termine par une seule
ligne `openedbot-gate/v1 <SHA-256 du JSON> <JSON>` : un descripteur d'au plus
1 Kio, qui porte la clé, `deletes` (`yes`, `no`, `unknown`, calculé sur les
arguments complets), `opaque`, le SHA-256 des arguments complets et les seuls
arguments utiles à la décision (chemin normalisé et taille, opérations d'un
correctif, action, destinataire, langage et taille du code, arguments MCP
masqués), jamais un contenu de fichier. Hermes masque la description avant de
l'émettre ; si ce masquage touche la ligne, son condensé ne correspond plus
et openedbot traite la gate comme inconnue, donc la soumet à une
personne. Un outil MCP n'est jamais `no` : Hermes ne garde pas l'annotation
`destructiveHint`. Un outil dont l'identité n'est pas prouvable (serveur MCP
absent du registre, arguments illisibles) garde une gate sans `rule_key` ni
descripteur. Un outil de `blockedTools` est bloqué sans gate. Le golden
`test/golden/operator/approval_gates.json` fige ces messages, et openedbot
le relit (`modules/execution/tests/gate-identity-golden.test.ts`).

### Skills Hub

The `skills_hub` feature is announced only when the installed Hermes exposes
the upstream Skills Hub functions. Search, inspect and scan are read-only;
scan always uses a quarantine copy. Install starts a persisted operation and
the host re-reads the profile skills before reporting success. `ask` is a
block, and community provenance is refused even when the upstream policy says
`allow`.

| Route | Body / result |
|---|---|
| `POST /hermes-setup/skills/hub/search` | `{"query", "source"?, "limit"?}`; returns bounded result rows |
| `POST /hermes-setup/skills/hub/inspect` | `{"identifier"}`; returns metadata and a `skillMdPreview` capped at 64 KiB |
| `POST /hermes-setup/profiles/{slug}/skills/hub/scan` | `{"identifier"}`; returns trust, source, verdict (`safe`, `caution` or `dangerous`), policy and up to 128 findings shaped as `{"severity", "category", "description", "file", "line"}`; strings are capped at 1000 characters and `file` or `line` may be null |
| `POST /hermes-setup/profiles/{slug}/skills/hub/install` | `{"identifier"}`; 202 `{"operationId"}` |
| `GET /hermes-setup/profiles/{slug}/skills/hub/operations/{uuid}` | persisted `queued`, `running`, `succeeded` or `failed` state |
| `DELETE /hermes-setup/profiles/{slug}/skills/{skill}` | removes the bounded skill name and returns the re-read skill list |

La création appelle `create_profile(name, clone_config=True)` depuis `default`,
écrit `API_SERVER_KEY=<bearer local>` dans le `.env` du profil en `0600`, sème
dans le `auth.json` du profil le seul `active_provider` de la racine (aucun
grant : un login OAuth copié est révoqué pour la racine au premier refresh ;
le profil lit le grant racine par le repli par fournisseur de l'amont), puis
relit `profiles`. Mesuré : sans ce semis, un profil dont la racine s'authentifie
par OAuth voit le fournisseur « authentifié » sur `/api/model/options` et
échoue quand même en « No inference provider configured » au premier run. Le bearer est lu par le Go via `hermes.Token()` et passe à la
sonde par stdin ; il n'est ni en argv, ni journalisé, ni dans la réponse. La
suppression appelle `delete_profile(name, yes=True)` et relit l'inventaire.
`default` est toujours refusé.

Le toolset exécute `hermes -p <slug> tools enable|disable <toolset>
--platform api_server`, puis relit `/p/<slug>/v1/toolsets` avec le bearer local.
L'activation de `cronjob` ou `delegation` reste `403 TOOLSET_FORBIDDEN` sur
un profil ; `memory` et `session_search` y sont acceptés. Le MCP n'accepte qu'un serveur
déjà défini à la racine : la sonde modifie `mcp_servers.<server>.enabled` et
la liste `platform_toolsets.api_server` dans le profil, puis l'inventaire relu
porte l'état. Toute écriture MCP pose le marqueur `restart pending` existant.

Une skill est validée contre le dossier `skills/` du profil (`404 SKILL_NOT_FOUND`
si le dossier n'en contient pas). La sonde `profile-skill-set` écrit la liste
`disabled_skills` dans le `config.yaml` du profil (même clé que
`profiles.configure` de Hermes Desktop) et `skills.disabled`, que
`hermes_cli.skills_config.save_disabled_skills` persiste. L'inventaire relu
porte `skills[].enabled`.

La route `POST /hermes-setup/profiles/{slug}/bundled-skills` reçoit uniquement
`{"enabled": true|false}`. Elle lit `.bundled_manifest`, intersecte ses noms
avec les skills installées, puis écrit une seule fois `disabled_skills` dans le
`config.yaml` du profil. La réponse indique `profile`, `requested`, `bundled`,
`bundledEnabled` et `applied`, vérifiés après relecture. Un manifeste absent
signifie zéro skill groupée. Les skills apprises et celles installées depuis le
hub restent intactes. La feature `profile_bundled_skills` est annoncée sous les
mêmes conditions que `profile_capabilities`.

Un credential de profil tente d'abord `hermes -p <slug> auth add <provider>
--type api-key` (clé sur stdin). Si la CLI refuse, la sonde écrit la variable
`key_env` du fournisseur dans le `.env` du profil, stdin seulement, et pose
la marque `openedbot:profile-own`. La preuve est `authenticated` relu sur
`/p/<slug>/api/model/options`, jamais un code de sortie. La valeur de la clé
n'est ni relue, ni journalisée, ni rendue.

Les erreurs d'exécution ou de preuve qui ne font pas partie de ce jeu fermé
sont rendues comme indisponibilité hôte, sans traceback, chemin ni secret.

### Les fichiers qu'un bot livre

`GET /hermes-setup/workspace/files/{file}` rend UN fichier qu'un bot a
fabriqué à la racine du `/workspace` de son bac à sable terminal
(`/srv/hermes/data/workspaces` sur l'hôte) et désigné par une ligne
`MEDIA:/workspace/<nom>`. Hermes n'intègre ces lignes que sur ses routes de
chat, pas sur `/v1/runs` (mesuré sur la VM 240, 2026-11-03) : le worker lit le
fichier ici pour le joindre au message.

C'est un nom, jamais un chemin : `[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}` suivi de
`.png`, `.jpg`, `.jpeg`, `.webp` ou `.pdf`, sans dossier, sans point initial,
sans préfixe `/p/<slug>` ni query. Le bot possède ce dossier et peut y poser
un lien symbolique ou une FIFO : la lecture passe par `os.Root` (aucune
résolution hors de la racine), s'ouvre en `O_NONBLOCK`, n'accepte qu'un
fichier ordinaire de 1 Mio au plus, et les octets doivent être une image ou un
PDF (nombre magique), quoi que dise l'extension. Le `Content-Type` vient des
octets. Aucune feature n'est annoncée : un hôte plus ancien refuse la route,
et openedbot garde alors le nom du fichier dans le texte.

### L'inventaire des sessions

`GET /hermes-setup/sessions-inventory`, annoncé `sessions_inventory`, rend
`{"sessions": [{"id", "profile", "createdAt"}], "total", "truncated"}` : les
identifiants de session du profil `default` puis de chaque profil nommé,
lus page par page sur `GET /api/sessions` du loopback (archivées comprises,
`limit=100`, ordre de création), bornés à 500 lignes : au-delà `truncated`
vaut `true`. Ni titre, ni modèle, ni message, ni chemin : `id` respecte la
grammaire des sessions, `createdAt` est `started_at` en RFC 3339 UTC.

openedbot recoupe cette liste avec les runs qu'il a lui-même dispatchés
par le lien : une session qu'il n'a jamais créée est une **création hors du
lien** (un processus local sur le loopback), journalisée `unattributed_session`.
Sur l'hôte, `up --firewall` réserve d'ailleurs les ports privés `8642` et
`9119` à root et à l'utilisateur de service par des règles iptables `owner`
(unité `hermes-loopback-guard`, vérifiée par `doctor`) : tout autre uid est
rejeté avant la connexion. Un gateway sans lecteur de sessions n'annonce pas
la feature, et l'inventaire échoue fermé (`502 HOST_UNAVAILABLE`) plutôt que
de rendre une liste partielle.

### Le programme d'inventaire

Les lectures et les écritures MCP passent par un programme Python **embarqué
dans le binaire**, réécrit par l'opérateur à chaque démarrage sous
`/usr/local/lib/hermes-setup/inventory-probe.py`, appartenant à root et jamais
inscriptible par l'utilisateur de service qui l'exécute. Son `argv` est le
chemin du programme plus **un verbe d'un jeu fermé** ; la requête (qui peut
porter un jeton) voyage sur stdin, jamais dans `argv` où `/proc` l'exposerait.

Il rend un unique document JSON borné. Un refus du contrat est un document
(`{"error":{code,message}}`) avec un code du jeu fermé ; tout autre code, y
compris `HOST_FAILED`, est remplacé par `HOST_UNAVAILABLE` sans texte amont :
une trace Python peut contenir un chemin, une URL ou un secret.

Le programme d'autorisation OAuth (`/usr/local/lib/hermes-setup/mcp-oauth-probe.py`,
mêmes propriétaire et mode) est son jumeau **longue durée** : il doit tenir le
vérificateur PKCE et l'enregistrement de client entre l'URL d'autorisation et
le callback. `argv` ne porte rien ; la requête `{name, redirectUri}` puis le
callback `{code, state}` sont deux lignes JSON sur stdin, et stdout rend des
**événements** JSON par ligne (`authorization_url`, `approved`, `error`) d'un
jeu fermé. Le flux OAuth lui-même (découverte, enregistrement dynamique,
PKCE, `state`, échange et stockage du jeton) reste celui de l'amont
(`tools.mcp_oauth`, `tools.mcp_dashboard_oauth`).

## Rejeu des événements

L'`api_server` amont n'a pas de rejeu documenté. Le connecteur tient donc, par
run, un journal borné (10 000 événements / 50 MiB) sous
`/var/lib/hermes-connector/runs/<run_id>.jsonl` : à la première réponse 2xx de
`POST /v1/runs`, il ouvre **une** souscription amont `/v1/runs/{id}/events`
indépendante de la connexion openedbot, et y écrit `{seq, ts, event}` avec
`seq` monotone à partir de 1.

Une requête `GET /v1/runs/{id}/events?since=<n>` (ou `Last-Event-ID: <n>`)
reçoit le rejeu depuis `n+1` puis le temps réel, chaque trame SSE portant
`id: <seq>`. `/v1/capabilities` relayé porte `features.event_replay: true`
quand le journal est actif, et `features.provider_management: true` ainsi que
`features.provider_usage: true` quand le socket de l'opérateur existe (le
connecteur réécrit le JSON du gateway, sans en retirer aucune clé).
Sans journal (démon redémarré en cours de run) : `event: replay-gap`, puis le
temps réel depuis `seq=1` ; openedbot décide (aujourd'hui : bascule en
`polling` de `GET /v1/runs/{id}`).
Un journal existant mais non terminé (démon redémarré après le premier
événement) est repris au premier rejeu par une nouvelle souscription amont ;
les événements que l'amont renverrait depuis le début ne sont pas journalisés
deux fois. Une fin du flux amont sans événement terminal n'achève pas le run :
le connecteur lit `GET /v1/runs/{id}` et ne clôt le journal que pour un état
terminal ou un run inconnu (404) ; sinon il se réabonne (5 fois de suite au
plus sans nouvel événement, le rejeu suivant relance alors la souscription).

Rétention : 7 jours après l'événement terminal ; plafond 50 MiB par run
(coupure + `event: journal-truncated`).

## Preuve de possession

Le jeton de lien est en clair sur l'hôte (`link.json`, credential systemd) :
volé, il ouvrirait une session. La preuve de possession lie chaque session à
une **clé device** Ed25519 que seul cet hôte détient.

- **Clé.** Générée par `edge-setup link` (une par enrôlement). Le seed de 32 octets ne touche jamais le
  disque en clair : il part sur stdin de `systemd-creds encrypt
  --name=device.key --with-key=tpm2|host` (TPM2 si `/dev/tpmrm0` existe,
  sinon la clé hôte de `/var/lib/systemd/credential.secret`) et le résultat
  scellé est écrit dans `/etc/hermes/connector/device.key.cred` (root 0600).
  L'unité charge `LoadCredentialEncrypted=device.key:…` : PID 1 le descelle
  dans `$CREDENTIALS_DIRECTORY`. systemd réserve un credential à l'uid de
  l'unité, pas à l'unité : la copie en clair est lisible par tout processus
  de l'uid `hermes`, que le connecteur partage avec le gateway. Trois
  protections la tiennent hors de portée du gateway. Son unité masque
  `/run/credentials` (`InaccessiblePaths=-/run/credentials`, dossier créé avant
  par un `ExecStartPre=` pour que le masque tienne aussi au démarrage à
  froid). Le connecteur se rend non dumpable avant de lire un credential
  (`prctl(PR_SET_DUMPABLE, 0)`) : les autres processus de l'uid `hermes` ne
  peuvent plus ouvrir `/proc/<pid>/{root,cwd,fd,environ,mem}`, quelle que soit
  la version de systemd (la fenêtre entre l'`execve` et cet appel se compte en
  millisecondes). Le gateway partage la vue des processus de l'hôte, sans
  `PrivatePIDs=` : Hermes 0.22 y prouve son gateway vivant (fichier PID, verrou,
  enregistrement relu dans `/proc`), et un espace PID privé lui fait inscrire le
  PID 1, ce qui fait manquer le multiplexeur aux commandes de profil côté hôte.
  Il voit donc le PID du connecteur, jamais sa racine, ses descripteurs, son
  environnement ni sa mémoire. Le connecteur garde son propre `PrivatePIDs=true`
  (systemd 257 et plus).
  Sans ce credential, le démon refuse de démarrer (code 2).
- **Hello.** Chaque session, enrôlement compris, annonce `devicePublicKey`.
  openedbot l'enregistre à l'enrôlement puis exige qu'il ne change plus :
  une session dont `hello` porte une autre clé est fermée `4401`
  `LINK_POP_FAILED` avant tout `link.challenge`, quel que soit le jeton, et
  journalisée `pop_failed` (`rekey_refused`).
- **Challenge.** Juste après `hello`, openedbot envoie `link.challenge
  {nonce}` (32 octets aléatoires). L'hôte répond aussitôt `link.proof
  {signature}` = Ed25519 sur le message exact

  ```text
  "openedbot-link-pop/v1\n" || nonce || "\n" || runtimeId || "\n" || wsURL || "\n"
  ```

  où `runtimeId` est vide pendant l'enrôlement et `wsURL` est l'URL telle
  que dialée (`wss://<openedbot>/api/runtime-links/ws`, ou `ws://127.0.0.1:<port>/…`
  derrière le tunnel de développement). Un nonce ne sert qu'une fois ; une
  preuve ne vaut que pour ce broker et ce runtime.
- **Avant la preuve.** Une `req` reçue avant `link.proof` est refusée
  `LINK_POP_PENDING` (`before_dispatch`, jamais émise vers le gateway).
  Exception : la session d'**enrôlement** (ticket) sert sa sonde sans
  preuve : le runtime n'existe pas encore, aucun challenge n'est possible,
  et c'est l'enrôlement lui-même qui enregistre la clé portée par `hello`. Un
  openedbot antérieur ne challenge jamais : passé 10 s sans
  `link.challenge`, l'hôte journalise « pop not requested » et sert les
  requêtes, pour qu'un connecteur neuf reste utilisable pendant le
  déploiement de l'API ; l'API, elle, refuse une session sans preuve dès que
  `RUNTIME_LINK_REQUIRE_POP=1`.
- **Changement de clé.** Aucun. La nouvelle clé ne prouverait que sa propre
  possession : un jeton de lien volé suffirait à remplacer celle de la
  machine. Une machine qui doit changer de clé (clé hôte régénérée, VPS
  cloné, soupçon de fuite) est réenrôlée avec un nouveau ticket, ce qui
  scelle et enregistre une nouvelle clé, puis remplace l'ancien runtime.
  `link --rekey` est retiré et refuse sans rien changer. Seule exception :
  un runtime lié avant l'existence de la preuve, qui n'a encore aucune clé
  enregistrée, reçoit la sienne à la première mise à jour (`up`/`upgrade` la
  scellent si `link.json` existe), sous le jeton courant seulement.

## Changement d'origine annoncé par `link.context`

Depuis v0.5.7, `openedbot` dans `link.context` n'est plus seulement affiché : quand
openedbot change de nom sous le même domaine, le connecteur suit sans
nouveau ticket. Il adopte l'origine annoncée seulement si les quatre
conditions tiennent (`connector.MovedWSURL`) :

1. le lien est de production : il compose `wss://`, jamais un tunnel `ws://`
   de développement ;
2. l'origine annoncée est `https://`, sans chemin, sans port différent ;
3. l'un des deux hôtes est un sous-domaine de l'autre
   (`console.openedbot.app` et `openedbot.app`) : jamais un autre domaine,
   jamais un voisin, jamais une adresse IP ;
4. aucune bascule n'est déjà en cours, et cette cible n'a pas déjà échoué
   pendant la vie du processus.

Le connecteur écrit alors la nouvelle URL dans
`StateDirectory/link-origin.json` (0600, liée à son `runtime_id`, revalidée à
chaque démarrage comme `link.json`), ferme la session et compose la nouvelle
origine. Le runtime, le jeton et la clé device ne changent pas : la preuve de
la session suivante signe la nouvelle URL, qu'openedbot accepte comme son
origine publique. L'ancienne reste acceptée côté serveur
(`RUNTIME_LINK_LEGACY_PUBLIC_URLS`) tant qu'un hôte peut encore la composer.

Si trois sessions de suite échouent sur la nouvelle origine sans être
confirmées, le connecteur revient à l'ancienne, l'écrit, et ne retente pas
cette cible avant son prochain redémarrage. Un `link` vers une autre origine et
`unlink` effacent `link-origin.json` ; après un ré-enrôlement sur la même
origine, le fichier reste mais son `runtime_id` ne correspond plus à celui du
nouveau lien, et le démon l'ignore.

## Instances nommées : dev et prod sur un même hôte

Un `hermes-connector` est **un** lien : un `link.json`, une clé device, une
unité, un répertoire d'état. Sans rien de plus, `link --openedbot` vers une autre
origine arrêtait l'unité et écrasait le lien précédent. Cas mesuré : un
VPS lié à la production, puis un tunnel SSH inverse et un `link` vers
`http://127.0.0.1:8790`, et l'API locale répondait `503
RUNTIME_LINK_UNAVAILABLE` parce que l'unique lien visait la production.

`link --name <name>` (`^[a-z][a-z0-9-]{0,31}$` ; `default`, `runs`,
`diagnostics` et `creation-audit` sont réservés) crée une **instance nommée**
à côté du lien par défaut :

| | instance par défaut (sans `--name`) | instance `<name>` |
|---|---|---|
| lien | `/etc/hermes/connector/link.json` | `/etc/hermes/connector/<name>/link.json` |
| clé device scellée | `/etc/hermes/connector/device.key.cred` | `/etc/hermes/connector/<name>/device.key.cred` |
| unité | `hermes-connector.service` | `hermes-connector@<name>.service` (template `hermes-connector@.service`, `%i` = nom) |
| état (`$STATE_DIRECTORY`) | `/var/lib/hermes-connector` | `/var/lib/hermes-connector/<name>` |
| contexte du lien (`link.context`, palier et propriétaire) | `link.json` puis `/var/lib/hermes-connector/link-context.json` | `<name>/link.json` puis `/var/lib/hermes-connector/<name>/link-context.json` |
| journal des runs, spool de diagnostics, audit de création | sous l'état ci-dessus | sous l'état ci-dessus |

Le démon ne change pas : il lit `link.json` et `device.key` dans
`$CREDENTIALS_DIRECTORY` et son état dans `$STATE_DIRECTORY`, que l'unité
template fixe par `%i` (`StateDirectory=hermes-connector/%i`,
`Environment=HERMES_CONNECTOR_INSTANCE=%i` ne sert qu'au repli hors systemd).
Deux instances ne partagent donc ni journal de rejeu, ni clé d'audit, ni clé
device ; chacune est un runtime distinct côté openedbot (ligne `runtimes`
propre, génération propre, aucun conflit de clôture entre brokers). Ce qui
reste **partagé** : le bearer du gateway (`runtime.env`), donc la même
surface gateway, les mêmes profils et les mêmes sessions pour les deux
openedbot, et le socket de l'opérateur.

Un gateway, une organisation. Deux instances sur la **même** origine
donneraient ce gateway partagé à deux organisations d'un même openedbot, que
rien n'isole sur l'hôte : `link` refuse donc, avant de dépenser le ticket,
une origine qu'une autre instance relie déjà, et nomme cette instance et son
runtime. Pour donner la machine à une autre organisation, on ré-enrôle
l'instance existante. Ce n'est pas une frontière
(root réécrit `link.json` à la main), c'est un garde-fou contre l'erreur.

Sans `--name`, rien ne change pour un hôte déjà provisionné : mêmes chemins,
même unité, pas de migration.

Reprise. `link` est un *updateOrCreate* : il écrit le lien de l'instance
visée, quel qu'ait été le précédent. Basculer l'hôte du développement vers la
production, ou l'inverse, est la même commande avec une autre `--openedbot`. Il n'y
a aucun drapeau à lever : `--replace` a été retiré.

Ce n'est pas un relâchement, parce que ce refus n'a jamais été une frontière.
`link` tourne en **root sur l'hôte**, et root réécrit `link.json` à la main de
toute façon ; le refus n'était payé que par l'opérateur qui avait une raison
légitime de basculer. Les frontières réelles sont ailleurs, inchangées :

- un enrôlement exige un **ticket** émis par un propriétaire authentifié dans
  openedbot, à usage unique et périmable ;
- une origine `http://` n'est acceptée que sur la **loopback** et seulement
  derrière `--insecure-openedbot`, donc uniquement au bout d'un tunnel SSH inverse
  que l'hôte d'un client n'a pas ;
- `reset` est ce qui retire le runtime pour de bon.

Ce qui est dû, en revanche, c'est la vérité avant que le ticket ne soit
consommé : la reprise nomme l'origine quittée et le runtime qui va s'y figer,
car cet openedbot garde une ligne `runtimes` que l'hôte ne rappellera plus.
Un nouveau ticket sur l'origine déjà liée est un ré-enrôlement, pas une
bascule, et il est annoncé comme tel.

```bash
# bascule vers la production
edge-setup link --openedbot https://link.openedbot.app --yes
# bascule vers un openedbot de développement, derrière make link-dev-up
edge-setup link --openedbot http://127.0.0.1:8790 --yes --insecure-openedbot
# garder les deux liens vivants en même temps : une instance nommée
edge-setup link --openedbot http://127.0.0.1:8790 --yes --insecure-openedbot --name dev
edge-setup status          # une ligne par instance : origine, runtime, unité, clé
journalctl -u hermes-connector@dev
```

`status` liste chaque instance (`openedbot`, `runtime_id`, unité active, clé device
scellée ; JSON `connectors[]`, `connector_active` et `link_present` restant
ceux de l'instance par défaut). `upgrade` et `up` installent le template avec
l'unité par défaut, scellent une clé device pour chaque instance liée qui n'en
a pas, et `try-restart` chaque unité (`hermes-connector` et
`hermes-connector@*`). `doctor` signale une instance liée dont l'unité est
inactive ; `audit` exige `root:root 0600` sur chaque `link.json` ; `reset`
arrête `hermes-connector@*` et retire le template.

## Reconnexion

Backoff `1 s × 2^n`, plafond 60 s, jitter ±10 % ; après au moins 30 s de session
confirmée par une trame du broker, le délai de la prochaine reprise revient à 1 s.
Une session qui retombe immédiatement ne remet pas ce délai à zéro.

Exception : une fermeture 4005 `LINK_RECONNECT_REQUESTED` remet le délai à
1 s quelle que soit la durée de la session. openedbot ne l'envoie qu'après
un ping WebSocket resté sans pong ni autre trame (« Vérifier le lien » dans les
réglages du runtime) : la session est déjà morte, il n'y a pas d'incident à
amortir. Elle ne compte pas comme refus. Un hôte plus ancien reconnecte quand
même, avec son backoff.

Un refus n'est pas une panne réseau. Une montée répondue HTTP 401 ou 403, ou
une fermeture 4401, compte comme refus ; une session confirmée remet le compte
à zéro, une coupure réseau ne compte pas. Au **10e refus consécutif**, le démon
écrit la raison dans `link-refused`, sous son répertoire d'état, et ne réessaie
plus que toutes les **30 min** (±10 %). Un runtime supprimé ne guérit pas en
frappant, mais un refus causé côté openedbot (déploiement fautif, base
restaurée) guérit, et une unité arrêtée ne l'aurait jamais vu. La première
session confirmée efface le marqueur. Une fermeture 4004 (révocation) arrête
le démon avec le code 78, que l'unité liste dans `RestartPreventExitStatus` :
systemd ne le relance pas. Dans les deux cas `status` affiche `refused` et
`doctor` nomme la commande à jouer ; `edge-setup link` avec un nouveau ticket
efface ce marqueur et redémarre l'unité.

Une origine locale (`127.0.0.1`, `localhost` : le tunnel de `make link-dev-up`)
est réessayée toutes les 2 s, sans le backoff d'incident. Si elle refuse toutes
les montées pendant **60 s** sans session confirmée, le démon s'arrête avec le
code 75, que l'unité liste aussi dans `RestartPreventExitStatus` : le tunnel est
fermé, et `make link-dev-up` redémarre l'unité. Une origine publique ne
s'arrête jamais ainsi : une panne d'openedbot doit guérir sans personne sur
l'hôte. Pendant ces tentatives, les fonctions lues à l'opérateur pour un hello
jamais envoyé servent encore 60 s : chaque lecture lance une sonde Python.

À chaque session admise (réception de `link.context`, qui ne suit qu'une preuve
de possession acceptée), le démon écrit `link-admitted` dans le même
répertoire : la date et l'agent `edge-setup/<version>`. La mise à jour
automatique s'en sert pour prouver le lien sur le nouveau binaire
(docs/OPERATIONS.md).

Ping WebSocket toutes les
15 à 20 s, pong attendu sous 30 s. À la perte du lien : les flux autres que
`events` sont annulés (openedbot voit `requestDelivery: ambiguous`), les
souscriptions amont continuent d'alimenter le journal.

## Journaux et alertes réseau

Le démon écrit les pertes du lien, les tentatives de reconnexion, les pongs
absents et la disponibilité de l’opérateur sur stderr, capturé nativement par
systemd : `journalctl -u hermes-connector --since "1 hour ago"`. Une trame reçue
du broker confirme le retour du lien dans le journal. La persistance au-delà
d’un reboot dépend de la configuration journald de l’hôte.

Les alertes Discord sont optionnelles : l’administrateur place l’URL dans un
fichier root `0600`, puis ajoute à un drop-in de `hermes-connector.service` :

```ini
[Service]
LoadCredential=alert-webhook:/etc/hermes/connector/alert-webhook
```

Les instances nommées (`hermes-connector@<name>`) n'héritent pas des drop-ins
de l'unité par défaut : poser les mêmes fichiers sous
`/etc/systemd/system/hermes-connector@.service.d/` (`alerts.conf`, et
`creation-audit.conf` si l'audit de création est activé), puis
`daemon-reload` et redémarrer chaque instance. Sans cela une instance `dev`
tourne sans alerte Discord ni audit de création, silencieusement.

Après `daemon-reload` et redémarrage du connecteur, le journal confirme
`Discord health alerts enabled`. Le secret n’est ni embarqué, ni commité,
ni passé en argument ; un credential absent laisse les logs natifs actifs.
Le webhook doit être une URL HTTPS `discord.com/api/webhooks/<id>/<token>`.

Un worker indépendant envoie une carte Discord native en français : état
explicite, composant `link` ou `operator`, début, durée et heure du retour.
Le titre est préfixé du palier (`[prod] Connexion interrompue`) et la carte
porte quatre champs de contexte : **Environnement** (`dev`,
`prod`), **Instance** (`default` ou le `--name`), **openedbot** (l’hôte de
l’origine) et **Utilisateur** (e-mail du propriétaire et nom de
l’organisation), puisque plusieurs openedbot postent dans un même canal
et qu’un VPS peut porter un lien dev et un lien prod. Ils viennent de
`link.context` : écrits dans `link.json` à l’enrôlement, rafraîchis par le
démon dans `$STATE_DIRECTORY/link-context.json` (le credential `link.json`
lui est en lecture seule sous `ProtectSystem=strict`), donc connus même quand
l’alerte part parce qu’openedbot est injoignable. Ce qu’aucune session n’a
déclaré s’affiche `inconnu` ; le balisage et les mentions sont neutralisés.
La couleur renforce le texte ; une récupération partielle ne masque pas un
composant encore indisponible. Aucune donnée de bot, aucun identifiant ni texte
d’erreur amont n’est envoyé, et les mentions Discord sont désactivées.
Une coupure plus courte que **soixante secondes n’est pas annoncée du tout** :
ni sa perte, ni son retour. Remplacer le processus openedbot ferme toutes les
WebSockets des connecteurs, l’hôte reconnecte dans la seconde, et une carte
pour cela n’apprend au lecteur qu’à ignorer le canal. Ce délai se compte depuis
la chute : une panne réelle est annoncée avec une minute de retard, et sa carte
porte alors la durée confirmée au lieu de l’âge de la détection. Journald garde
la trace des deux dans tous les cas. Un incident confirmé dont la carte n’a pas
pu partir n’est pas oublié : il est annoncé comme incident rétabli dès que
Discord répond. Un composant encore dans son délai est nommé sur la carte qu’un
AUTRE composant déclenche, pour qu’un rétablissement ne dise jamais que tout est
revenu pendant que l’autre est à terre.

Les états répétés sont dédupliqués,
les envois espacés d’au moins une minute, chaque requête bornée à cinq secondes,
et `Retry-After` respecté pour les délais entre une minute et un jour.
Une panne Discord ou réseau laisse l’état en attente en mémoire ; un
rétablissement avant livraison est annoncé comme incident rétabli. Les attentes
ne survivent pas au redémarrage du processus : journald reste la preuve durable.
Une coupure Internet totale ou l’arrêt du VPS empêchent l’envoi depuis l’hôte ;
une surveillance extérieure est nécessaire pour alerter pendant cette coupure.

### Diagnostics persistants dans openedbot

Indépendamment de Discord, le démon conserve les transitions dans un fichier
privé `0600` sous son répertoire d’état `diagnostics/<empreinte du runtime et du serveur>/pending.json`.
Un nouvel enrôlement ne réattribue donc pas les erreurs de l’ancien runtime.
Le plafond est de 128 événements ; au-delà, le plus ancien est retiré avec un
avertissement explicite dans journald. Une ouverture impossible du fichier désactive
cette collecte avec un message local, sans empêcher la connexion Hermes.

Après la première trame du broker, le démon transmet au plus quatre événements
toutes les cinq secondes sur le WebSocket existant. Un événement reste sur disque
jusqu’à `diagnostic.ack`. Une ancienne API ignore ces trames : la file reste bornée,
sans déclencher de reconnexion. L’API et la migration 0050 doivent donc précéder
le nouveau connecteur.

Chaque diagnostic porte un UUID stable, un composant `link|operator`, l’état
`unavailable|recovered`, un code `^[A-Z][A-Z0-9_]{0,63}$`, une date ISO, un résumé
fixe de 256 octets maximum et une trace optionnelle de 8192 octets maximum.
Les causes distinguent notamment EOF, connexion refusée/réinitialisée, DNS,
certificat non reconnu et pong expiré. La trace Go est la pile **au point de
signalement**, composée de fonctions, noms de fichiers et numéros de ligne ;
ce n’est pas une pile de création d’erreur reconstruite. Aucun argument,
variable locale, token, URL privée ni texte d’erreur arbitraire n’est collecté.

`runtime_link_diagnostics` conserve les événements avec isolation par organisation
et contrainte unique `(runtime_id,event_id)`. L’API confirme après la transaction,
expurge encore les motifs de secrets connus et limite à quatre écritures simultanées
par connexion. Une erreur SQL laisse l’événement rejouable. La lecture
`GET /api/runtime/:runtimeId/diagnostics?limit=50` est réservée aux rôles owner/admin
de l’organisation, avec une limite comprise entre 1 et 100. Une trace absente est NULL.
La révocation logique d’un runtime conserve son historique ; seule sa suppression
SQL physique déclenche la cascade. Le centre Admin et sa politique de rétention
relèvent d'un chantier distinct de cette première collecte.

### Audit de création chiffré

Avec `HERMES_CONNECTOR_CREATION_AUDIT=1`, que l'opérateur pose à la main dans
un drop-in systemd de l'unité (aucun gabarit ni aucune commande d'`edge-setup`
ne l'active, le démon se contente de lire la variable), le démon garde la
preuve de chaque `POST /v1/runs` qu'il dispatche (un événement `attempt` avant
l'envoi, un `outcome` après) dans
`creation-audit/<empreinte du runtime et du serveur>/snapshot.bin`.
Le fichier est **scellé** : illisible sans la clé que openedbot remet à
chaque session, et inaltérable sans détection.

Clé. Le démon n'écrit jamais de clé sur disque. À la liaison, openedbot
envoie `audit.key` avec la clé maîtresse courante du runtime (et jusqu'à deux
clés retirées encore acceptées en lecture). Le démon dérive la clé de
chiffrement par `HKDF-SHA256(clé maîtresse, salt = runtimeId,
info = "openedbot-creation-audit/v2/enc")`, ouvre le fichier avec la clé que son
en-tête nomme, vérifie la chaîne, puis rescelle sous la clé courante. Sans
clé (session non encore liée, API ancienne), une création répond
`err` `AUDIT_KEY_MISSING` `before_dispatch` : rien n'est dispatché sans preuve,
rien n'est écrit en clair. Les autres routes ne dépendent pas de la clé.

Format `snapshot.bin` (entiers big-endian) :

| Décalage | Taille | Champ |
|---|---|---|
| 0 | 8 | magic `OBAUDIT2` |
| 8 | 1 | version `0x02` |
| 9 | 1 | suite `0x01` = AES-256-GCM, HKDF-SHA256, SHA-256 |
| 10 | 2 | longueur `hlen` de l'en-tête (≤ 1024) |
| 12 | `hlen` | en-tête JSON canonique `{"keyId","runtimeId","schemaVersion":2,"writeSeq"}` |
| 12 + `hlen` | 12 | nonce aléatoire, unique par écriture |
| 24 + `hlen` | n | chiffré du snapshot canonique |
| 24 + `hlen` + n | 16 | tag GCM |

Les données associées sont tous les octets qui précèdent le chiffré : un
en-tête ou un nonce modifié fait échouer le tag. Le snapshot en clair porte
`schemaVersion`, `startedAt`, `lastWrittenAt`, `runtimeId`, `writeSeq`,
`count`, `dropped`, `base`, `tail`, `events`. `writeSeq` figure dans l'en-tête
et dans le clair ; un désaccord est un refus.

Chaîne. `base = SHA-256("openedbot-creation-audit/v2/genesis" || runtimeId)`, puis
`h_i = SHA-256(0x01 || canonical(e_i) || h_{i-1})` ; `tail` est le dernier
hachage. Quand l'anneau de 4096 événements déborde, l'événement le plus
ancien quitte le fichier mais pas la chaîne : `base` devient son hachage et
`dropped` s'incrémente, donc un vérificateur prouve encore chaque événement
retenu. JSON canonique : clés triées par unités de code UTF-16, aucun espace,
échappement minimal (`\" \\ \b \f \n \r \t`, autres contrôles en `\u00xx`
minuscules, ni HTML ni U+2028/2029), entiers seuls, champs vides omis.

Ancre. Après chaque écriture durable (et au début de chaque session, pour la
position courante), le démon envoie `audit.anchor {keyId, writeSeq, count,
dropped, tail}`. openedbot garde la dernière ancre : un export dont
`writeSeq` ou `tail` est en retrait est une copie antérieure, pas l'audit
courant. C'est ce que ni le chiffrement ni la chaîne seuls ne détectent.

Rotation. Une nouvelle clé arrive par `audit.key` avec l'ancienne dans
`previous` ; le démon rescelle immédiatement et envoie une ancre sous le
nouveau `keyId`. Un fichier scellé sous une clé absente de la trame est un
refus d'armement (créations refusées, lien maintenu), jamais un redémarrage à
vide.

Migration. Un `snapshot.json` v1 (clair) trouvé à l'ouverture est renommé
`snapshot.v1.json` pour l'opérateur ; il n'est jamais relu comme preuve et
openedbot refuse un export en clair. La chaîne v2 démarre à genesis.
Écriture atomique (`tmp` + `rename` + fsync du fichier et du répertoire),
verrou d'écrivain unique, mode `0600` et borne de 8 MiB sont conservés.

Ce que ça ne couvre pas : root vivant pendant l'exécution (la clé est en
mémoire du processus), l'horloge du VPS, une création qui n'emprunte pas le
lien. Une ancre absente (lien tombé entre l'écriture et l'envoi) est rattrapée
par la position renvoyée à la session suivante.

## Invariants

- La clé device n'est jamais écrite en clair par le module : elle est scellée
  par systemd-creds et descellée par PID 1 dans `$CREDENTIALS_DIRECTORY` de
  l'unité connecteur. systemd réserve ce credential à l'uid `hermes`, que le
  gateway partage, et non à la seule unité : le masque `/run/credentials` de
  l'unité du gateway, le connecteur non dumpable (`PR_SET_DUMPABLE`) et, dès
  systemd 257 seulement, `PrivatePIDs=true` le tiennent hors de portée du
  gateway (voir « Preuve de possession »). Une preuve de possession est liée au
  nonce, au runtime et à l'URL dialée ; une `req` avant la preuve est refusée
  `LINK_POP_PENDING` (sauf pendant l'enrôlement, qui n'a pas encore de runtime
  à défier).
- L'audit de création n'est jamais écrit en clair ni dispatché sans clé : un
  connecteur ancien écrit `snapshot.json` v1, un connecteur v2 refuse la
  création (`AUDIT_KEY_MISSING`) tant que `audit.key` n'est pas arrivée.

- openedbot ne compose aucune URL vers l'hôte : une ligne `runtimes` en
  mode `connector` a `endpoint` NULL par contrainte de base.
- Le bearer du gateway n'apparaît dans aucune trame sortante. Invariant prouvé
  par des tests (`internal/connector/*_test.go` cherchent le bearer dans toutes
  les trames reçues par le broker de test), non par un contrôle à l'exécution :
  le connecteur ne scanne pas ses trames.
- Le lien transporte exactement l'allowlist ; un chemin hors liste est refusé
  des deux côtés. Les routes hôte n'atteignent jamais le loopback gateway.
- Aucune trame de contrôle n’autorise l’exécution de shell ni l’accès à un chemin
  de fichier ; les traces de diagnostic sont uniquement du texte de journal. Le
  connecteur ne connaît que des verbes NOMMÉS : fournisseurs (identifiants et
  OAuth), lectures de capacités, d'usage et de contexte de modèle, toolsets,
  serveurs MCP et leur OAuth, profils (deux lectures, création, suppression,
  puis toolset, mémoire, modèle, MCP, skills et credentials par profil),
  inventaire des sessions, A2A (Agent Card, audit, politique des pairs), une
  lecture d'état du gateway, une lecture de suivi de redémarrage et **un**
  redémarrage, dont chaque segment variable est une classe bornée. Cette liste
  change : la source est `allowlist.go` (section « Allowlist » ci-dessus),
  jamais cette prose, d'où l'absence de compte. L'opérateur
  n'exécute que `hermes auth add`, `hermes auth list`, `hermes auth remove`,
  `hermes -p <slug> auth add`,
  `hermes tools enable|disable --platform api_server`,
  `hermes -p <slug> tools enable|disable --platform api_server`,
  `hermes -p <slug> plugins enable openedbot_approval_policy`,
  ou l'un de ses cinq programmes Python embarqués (usage, inventaire, OAuth
  MCP, politiques A2A et lecture de configuration d'approbation), tous sous l'utilisateur de service, plus
  `systemctl restart hermes-gateway`, que l'opérateur (root) confie à systemd.
- Le redémarrage du gateway est le seul que le lien porte : route fixe, unité
  fixe, aucun argument, prouvé sur `/health`, et un marqueur qui dit d'abord
  s'il est nécessaire. Aucun `update`, aucun `exec`, aucune autre unité.
- Une écriture n'est jamais rapportée sur la parole de la commande qui l'a
  faite : un credential est prouvé sur `/api/model/options`, un toolset sur
  `/v1/toolsets`. Une écriture qu'on ne sait pas relire se dit non vérifiée.
- Une capacité est annoncée seulement si l'opérateur peut la servir. Un hôte
  dont le programme d'inventaire n'a pas pu s'installer sert les verbes
  fournisseur et se tait sur les autres, pour qu'openedbot n'affiche pas un
  geste dont l'écriture échouerait.
- Une sonde (`/health` + `/v1/capabilities` + contrat toolsets) précède toute
  écriture côté openedbot, à l'enrôlement comme à l'activation.
- Le transport vers openedbot est TLS 1.3 au minimum : le dial WebSocket
  refuse un serveur (ou un chemin) qui n'offre que TLS 1.2. Au démarrage du
  démon, `ws_url` lu dans `link.json` est revalidé selon le contrat de
  l'enrôlement : `wss://` vers tout hôte, `ws://` seulement vers une loopback
  (tunnel SSH de développement), toujours le chemin `/api/runtime-links/ws` ;
  un fichier altéré ne peut pas rabattre le lien en clair vers une origine
  publique (refus, rien n'est démarré).
