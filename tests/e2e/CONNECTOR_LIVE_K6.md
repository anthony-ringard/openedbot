# E2E k6 du connecteur réel

Depuis la racine du dépôt :

```sh
make e2e-link-load
```

Ce test est lancé uniquement à la demande. Il utilise l'API déjà en service et
le runtime connecteur réellement actif du compte authentifié. Il ne lance pas
de serveur, ne compile pas le produit, ne déploie rien et ne change pas de runtime.

## Configuration

Le Makefile charge les fichiers `.env.local` habituels. Fournir explicitement :

- `E2E_EMAIL` et `E2E_PASSWORD` : compte de test owner/admin dans l'organisation ;
- `RELAY_INTERNAL_TOKEN` : secret du relais interne de l'API ;
- `K6_BIN` : chemin du binaire officiel k6, ou installer k6 dans `PATH`.

Le compte n'est pas déduit du Git, d'un seed ou d'une première ligne en base.
Les identifiants et le jeton restent dans l'environnement ; ne pas les committer.

Paramètres facultatifs :

- `E2E_API_URL` : API cible, par défaut `http://127.0.0.1:8790` ;
- `E2E_RUNTIME_ID` : runtime attendu, pour refuser une cible différente ;
- `E2E_ARTIFACT_DIR` : répertoire des résultats.

Exemple avec un k6 déjà téléchargé, les secrets étant préconfigurés :

```sh
K6_BIN=/chemin/vers/k6 make e2e-link-load
```

## Ce qui est testé

La chaîne réelle est : client k6, relais interne de l'API, WebSocket existante,
connecteur du VPS, puis `/health` du véritable Hermes. Huit utilisateurs virtuels
pendant dix secondes, avec une pause de 100 ms, sollicitent ce chemin en parallèle.
Le délai maximum d'une requête est de trois secondes.

Le test exige le mode externe. Il échoue si le runtime n'est pas un connecteur disponible, si une réponse
de santé échoue, si les seuils k6 échouent, si le runtime change ou si le journal
enregistre une nouvelle interruption/reconnexion pendant la mesure. Une preuve
de référence absente du journal ne permet pas de conclure au succès.

Les résultats identifient le runtime observé et conservent les métriques k6 et
la vérification du journal dans des artefacts horodatés. Un code de sortie non nul
signale l'échec. Les processus k6 sont terminés à la fin et la session d'authentification
créée par le test est révoquée, sans toucher aux autres sessions du compte.
Aucun bot ni session Hermes n'est créé. Le résultat n'est pas envoyé automatiquement sur Discord.

## Limites et tests complémentaires

Ce test valide le transport de bout en bout sur le VPS. Il ne mesure pas la
capacité d'inférence LLM et ne garantit pas le maintien de longs flux SSE sous
charge prolongée. Il n'injecte pas de panne sur des flux réels.

Le banc de saturation local (`tests/load/connector-k6.ts`, 64 requêtes, corrélation
POST/SSE, coupure de flux) a été retiré le 2026-10-10 ; ses preuves restent dans
`docs/reports/`. Le fixture Go `TestK6LoadHost` reste opt-in via `K6_BROKER_URL`.

Pour vérifier aussi la création et la réponse d'un bot avec un vrai fournisseur,
la recette `make e2e-bot` est distincte. Elle consomme le fournisseur configuré et
nettoie son bot et ses sessions ; ce coût n'est pas caché dans le test k6 de santé.
