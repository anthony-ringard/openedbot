# Worker openedbot

Ce workspace exécute les travaux asynchrones persistés dans PostgreSQL : runs
Hermes, steering et annulations, routines, maintenance des messages entrants,
suppression de tenants et envoi d’e-mails transactionnels. Il ne sert aucun
endpoint public.

## Architecture

La direction des dépendances est volontairement simple :

```text
index.ts + config.ts
└── application/worker-service.ts
    ├── execution/ ──► memory/
    ├── maintenance/
    └── infrastructure/
        ├── PostgreSQL (Bun SQL)
        ├── @openedbot/hermes
        ├── stockage fichier ou R2
        ├── endpoint d’e-mail transactionnel
        └── API interne openedbot par HTTP

apps/worker ──► @openedbot/hermes ──► @openedbot/contracts-*
      └───────────────────────► @openedbot/contracts-*
```

Il ne doit exister aucun import de source depuis `apps/api`. Quand le worker
doit notifier l’API, il utilise son contrat HTTP interne authentifié.

### Composition root

`src/index.ts` est le point d’entrée du processus. Il construit la configuration
et la connexion PostgreSQL, branche les signaux du processus et démarre le
service applicatif. Il reste volontairement minimal ; aucune règle métier ni
requête SQL ne doit y revenir.

`src/config.ts` lit et valide l’environnement. La configuration est ensuite
passée explicitement aux modules : ils ne doivent pas reconstruire une
configuration concurrente à partir de `process.env`. `WORKER_ID` est un
préfixe opérateur ; le processus lui ajoute toujours son PID et un suffixe
aléatoire afin que deux replicas ne puissent jamais partager un propriétaire
de bail.

### Application

`src/application/worker-service.ts` possède la boucle du worker. Il arbitre la
capacité d’exécution, supervise les annulations et garantit l’ordre d’arrêt. Il
orchestre les modules métier sans réimplémenter leurs règles ni les détails de
persistance.

La boucle de claim ne fait que réclamer et lancer des runs. Toute la maintenance
(`src/application/maintenance-jobs.ts`) tourne à côté, un job par fibre
single-flight (`background-jobs.ts`) : un SMTP, un provider push, R2 ou
Cloudflare lent ne retarde que son propre job, jamais le claim suivant. À
l’arrêt, runs et passes de maintenance en vol sont tous attendus avant la
restitution des baux.

Le réveil reste le sondage `WORKER_POLL_MS` (100 ms par défaut) : Bun SQL
n’expose pas les notifications `LISTEN`, et le worker n’a aucun endpoint HTTP
pour recevoir un hint de l’API.

### Execution

`src/execution/` contient le chemin critique des runs :

- `queue.ts` réclame et récupère les runs avec leurs baux PostgreSQL ;
- `runner.ts` exécute un run, normalise ses événements et publie les événements
  destinés aux clients ;
- `run-steering.ts` transmet les consignes à un run déjà actif ;
- `cancellation-watch.ts` interrompt rapidement les runs dont l’arrêt durable a
  été demandé.

Cette couche peut dépendre de `memory/`, de `@openedbot/hermes`, des contrats (`@openedbot/contracts-*`) et
des adaptateurs reçus par le composition root. Elle ne dépend pas de
`maintenance/`.

### Maintenance

`src/maintenance/` regroupe les travaux périodiques qui ne font pas partie de
l’exécution d’un run :

- `profile-imports.ts` et `profile-deletes.ts` jouent les imports et les
  suppressions de profils ;
- la purge des tenants (`@openedbot/identity/application/tenant-deletion`), le
  drainage de l’outbox transactionnelle (`@openedbot/notifications`), la
  réconciliation des messages entrants et de leurs pièces jointes
  (`@openedbot/conversation/application/message-ingress-maintenance`) et les routines
  dues (`@openedbot/execution`) vivent dans leurs modules ; `application/maintenance-jobs.ts`
  ne fait que les planifier.

Ces travaux partagent la même configuration et la même connexion PostgreSQL,
mais leur cadence reste indépendante du drainage de la file de runs.

### Infrastructure

L’infrastructure est exposée par des adaptateurs explicites plutôt que par des
imports vers l’API :

- PostgreSQL est la source de vérité et la file durable, via `Bun.SQL` ;
- `worker-registry.ts` isole le heartbeat du processus, la restitution des baux
  et le nettoyage de l’instance à l’arrêt ;
- `loop-health.ts` prouve que la boucle de claim tourne : le heartbeat de 5 s
  rafraîchit `WORKER_HEALTH_FILE` tant qu’un tour a eu lieu dans les 30 s, et
  `src/healthcheck.ts <fichier>` (healthcheck Docker) échoue au-delà de 15 s ;
- `blob-store.ts` centralise la suppression idempotente des objets fichier/R2 ;
- `@openedbot/hermes` porte le client, la politique d’endpoint, le flux SSE et le
  chiffrement des secrets Hermes partagés avec l’API ;
- l’API interne est appelée en HTTP avec `API_INTERNAL_URL` et un secret par
  rôle (ADR 0001, 4.7) : `EVENTS_INTERNAL_TOKEN` sur `/internal/events/publish`,
  `RELAY_INTERNAL_TOKEN` sur le relais du lien, `RUN_KEY_SECRET` pour signer
  les clés de run (l’ancien `WORKER_INTERNAL_TOKEN` n’est plus lu : le worker
  refuse de démarrer s’il le trouve) ;
- les blobs utilisent le driver fichier en développement ou R2 en production ;
- l’e-mail transactionnel passe par l’endpoint configuré, avec une clé de
  déduplication durable.

La dépendance autorisée est le contrat HTTP interne, jamais le code de
`apps/api`. `@openedbot/hermes` peut dépendre des contrats (`@openedbot/contracts-*`), mais ne doit dépendre
ni de `apps/api` ni de `apps/worker`.

### Memory

`src/memory/remember-facts.ts` applique transactionnellement les directives de
mémoire produites par un run. Ce module dépend uniquement des contrats
(`@openedbot/contracts-*`) et du type de transaction Bun fourni par l’appelant.

## Journalisation

Le processus émet des logs structurés. Le contrat est le suivant :

- un objet JSON sérialisé sur une seule ligne par appel à `console.info`,
  `console.warn` ou `console.error` ;
- une propriété `event` stable préfixée par `worker.`, puis des champs de
  contexte structurés comme `workerId`, `runId`, `organizationId` ou
  `attempts` ;
- aucune clé, aucun token, aucune variable d’environnement ni contenu privé ne
  doit être journalisé ;
- les erreurs doivent rester bornées et sur une ligne ;
- le processus n’ajoute pas lui-même de préfixe visuel. `make dev` ajoute le
  préfixe coloré `[WORKER]` lorsqu’il agrège les trois services.

Les logs directs du workspace restent donc exploitables comme JSON, tandis que
les logs du terminal de développement restent immédiatement identifiables.

## Commandes

Les cibles de développement ne démarrent ni l’infrastructure ni les migrations.
Après la préparation nécessaire, utiliser :

```bash
make dev            # API + Console + Worker, avec logs [API], [CONSOLE] et [WORKER]
make dev-worker     # Worker seul, en mode watch
make build-worker   # Produit dist/bin/openedbot-worker
make typecheck      # Vérifie tous les workspaces actifs, dont worker
make test           # Tests unitaires puis intégration PostgreSQL
```

Pour les seuls tests unitaires, `make test-unit` inclut
`apps/worker/tests`. `Ctrl-C` déclenche l’arrêt du worker et la libération de ses
baux avant la fermeture de la connexion PostgreSQL.
