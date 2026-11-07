SHELL := /usr/bin/env bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

# Monorepo OpenedBot/openedbot: edge-setup releases are tagged edge-setup/vX.Y.Z;
# the binary version drops the prefix (vX.Y.Z, vX.Y.Z-N-gSHA, ...-dirty).
VERSION ?= $(or $(shell git describe --tags --match 'edge-setup/v*' --always --dirty 2>/dev/null | sed 's|^edge-setup/||'),dev)
LDFLAGS := -s -w -X main.version=$(VERSION)
GOFLAGS := -trimpath -buildvcs=false
ARCHES := amd64 arm64
RELEASE_OSES := linux darwin
RELEASE_BINARIES := $(foreach os,$(RELEASE_OSES),$(foreach arch,$(ARCHES),edge-setup_$(os)_$(arch)))
# The install bootstrap served by the documentation site ships in the release
# too, checksummed and signed with the binaries.
INSTALL_SCRIPT ?= $(DOCS_DIR)/public/install
RELEASE_FILES := $(RELEASE_BINARIES) install.sh
RELEASE_ASSETS := $(addprefix dist/,$(RELEASE_FILES)) dist/SHA256SUMS
# Keyless signature: the release workflow on the tag, through GitHub OIDC.
# Hosts accept no other identity (internal/selfupdate/signature.go).
SIGNER_ISSUER := https://token.actions.githubusercontent.com
SIGNER_PREFIX := https://github.com/OpenedBot/openedbot/.github/workflows/edge-setup-release.yml@refs/tags/edge-setup/
SIGNED_DIR ?= dist-signed

# Monorepo OpenedBot/openedbot : la racine (application openedbot, qui porte la
# moitié TypeScript du contrat du lien) et docs/ (site de documentation, que
# check-docs compare à docs/ d'ici). Surchargeables, jamais devinés ailleurs.
OPENEDBOT_MAIN_DIR ?= ..
DOCS_DIR ?= ../docs

.PHONY: help build build-all release release-assets sign verify-signatures fetch-signed publish publish-check contract-check deploy deploy-host deploy-key-check check check-docs shellcheck fmt vet lint lint-tools test test-release test-update integration integration-vm docs-dev docs-build clean

# ─── Colors ──────────────────────────────────────────────────────────────────

C_SECTION := \033[1;33m
C_TARGET  := \033[36m
C_OK      := \033[32m
C_WARN    := \033[33m
C_ERR     := \033[31m
C_RESET   := \033[0m

# ─── Build / Release ─────────────────────────────────────────────────────────

build: ## Compile edge-setup pour cette machine dans ./dist
	@mkdir -p dist
	CGO_ENABLED=0 go build $(GOFLAGS) -ldflags='$(LDFLAGS)' -o dist/edge-setup ./cmd/edge-setup

build-all: ## Compile Linux/macOS amd64 et arm64 sans cgo
	@mkdir -p dist
	@rm -f $(RELEASE_ASSETS)
	@for os in $(RELEASE_OSES); do \
	  for arch in $(ARCHES); do \
	    CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch go build $(GOFLAGS) -ldflags='$(LDFLAGS)' \
	      -o dist/edge-setup_$${os}_$$arch ./cmd/edge-setup; \
	  done; \
	done
	@if [[ ! -f "$(INSTALL_SCRIPT)" ]]; then echo "install bootstrap introuvable : $(INSTALL_SCRIPT) (INSTALL_SCRIPT=...)" >&2; exit 2; fi
	@# A release installer must install its own release by default.
	@if [[ "$(VERSION)" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$$ ]] && ! grep -qx 'PINNED_VERSION="$(VERSION)"' "$(INSTALL_SCRIPT)"; then \
	  echo "$(INSTALL_SCRIPT) n'épingle pas $(VERSION) (PINNED_VERSION) : mettez-le à jour avant de taguer" >&2; exit 2; fi
	@cp "$(INSTALL_SCRIPT)" dist/install.sh
	@cd dist; \
	  if command -v sha256sum >/dev/null; then sha256sum $(RELEASE_FILES) > SHA256SUMS; \
	  elif command -v shasum >/dev/null; then shasum -a 256 $(RELEASE_FILES) > SHA256SUMS; \
	  else echo "outil SHA-256 manquant : sha256sum ou shasum requis" >&2; exit 2; fi

release-assets: ## Liste exacte des fichiers publics de la release
	@printf '%s\n' $(RELEASE_ASSETS)

release: build-all ## Binaires + SHA256SUMS non signés (la signature n'existe qu'en CI : sign) et .deb (nfpm) s'il est installé
	@cd dist; \
	  if command -v sha256sum >/dev/null; then sha256sum --check --quiet SHA256SUMS; \
	  elif command -v shasum >/dev/null; then shasum -a 256 --check SHA256SUMS >/dev/null; \
	  else echo "outil SHA-256 manquant : sha256sum ou shasum requis" >&2; exit 2; fi
	@if command -v nfpm >/dev/null; then \
	  for arch in $(ARCHES); do ARCH=$$arch VERSION=$(VERSION) nfpm package -f packaging/nfpm.yaml -p deb -t dist/; done; \
	else echo "nfpm absent : pas de .deb"; fi

# Les notes d'une release sont affichées telles quelles aux utilisateurs dans la
# console (« Nouveautés »). Elles parlent produit : aucun ticket, aucune route
# interne, aucun code d'erreur, aucun chemin de l'hôte. Le détail technique
# reste dans CHANGELOG.md et les commits.
NOTES_FORBIDDEN := \b[A-Z]{2,}-([A-Z]+-)?[0-9]+\b|/hermes-setup/|\b[A-Z][A-Z0-9]*(_[A-Z0-9]+){1,}\b|/(var|etc|run|srv|usr)/

notes-check: ## Refuse des notes de release (NOTES_FILE) qui exposent un ticket, une route interne, un code d'erreur ou un chemin
	@notes="$${NOTES_FILE:-}"; \
	  if [[ -z "$$notes" ]]; then exit 0; fi; \
	  if [[ ! -f "$$notes" ]]; then printf '$(C_ERR)[make]$(C_RESET) NOTES_FILE introuvable : %s\n' "$$notes"; exit 2; fi; \
	  rc=0; perl -CSD -ne 'if (m!$(NOTES_FORBIDDEN)!) { print "$$.: $$_"; $$f = 1 } END { exit($$f ? 0 : 1) }' "$$notes" || rc=$$?; \
	  if [[ $$rc -eq 0 ]]; then \
	    printf '$(C_ERR)[make]$(C_RESET) notes de release refusées : elles sont publiques ; retirez tickets, routes, codes et chemins (lignes ci-dessus).\n'; exit 2; \
	  elif [[ $$rc -ne 1 ]]; then printf '$(C_ERR)[make]$(C_RESET) notes-check : perl a échoué (%s), refus par prudence.\n' "$$rc"; exit 2; fi; \
	  rc=0; perl -CSD -ne 'if (/\x{2014}/) { print "$$.: $$_"; $$f = 1 } END { exit($$f ? 0 : 1) }' "$$notes" || rc=$$?; \
	  if [[ $$rc -eq 0 ]]; then printf '$(C_ERR)[make]$(C_RESET) notes de release refusées : tiret cadratin.\n'; exit 2; \
	  elif [[ $$rc -ne 1 ]]; then printf '$(C_ERR)[make]$(C_RESET) notes-check : perl a échoué (%s), refus par prudence.\n' "$$rc"; exit 2; fi; \
	  printf '$(C_OK)[make]$(C_RESET) notes de release : texte public, OK.\n'

publish-check: notes-check ## (interne) refuse de publier depuis un worktree sale ou sans version de release
	@if [[ "$(VERSION)" == *-dirty || "$(VERSION)" == dev ]]; then echo "VERSION=$(VERSION) : arbre sale ou sans tag, refusé (make publish VERSION=vX.Y.Z)"; exit 2; fi
	@status="$$(git status --porcelain --untracked-files=normal)" || { echo "impossible de vérifier l'état Git"; exit 2; }; \
	  if [[ -n "$$status" ]]; then echo "worktree sale : committez les changements avant make publish"; exit 2; fi

# ─── Signature ───────────────────────────────────────────────────────────────

# Configuration de signature de secours : le journal Rekor v2 (log2025-1) et
# l'horodatage TSA de Sigstore, tous deux déjà dans la racine de confiance
# que les hôtes lisent par TUF. Elle ne sert que si la signature par défaut
# (Rekor v1, choisi par la configuration publique) échoue, comme pendant la
# panne Rekor v1 du 2026-11-07. Le vérificateur des hôtes (sigstore-go) et
# `cosign verify-blob` acceptent les deux : une entrée de journal vérifiée et
# un horodatage observé, l'identité exacte restant celle du tag.
SIGN_FALLBACK_CONFIG ?= $(CURDIR)/scripts/sigstore-signing-config-rekor-v2.json
SIGN_DIR ?= dist

sign: ## (CI seulement) Signe SHA256SUMS et chaque fichier de dist/ en keyless (cosign, OIDC GitHub), Rekor v2 en secours
	@if [[ ! "$(VERSION)" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$$ ]]; then echo "VERSION=$(VERSION) : vX.Y.Z requis" >&2; exit 2; fi
	@command -v cosign >/dev/null || { echo "cosign absent" >&2; exit 2; }
	@[[ -f "$(SIGN_FALLBACK_CONFIG)" ]] || { echo "configuration de secours absente : $(SIGN_FALLBACK_CONFIG)" >&2; exit 2; }
	@cd "$(SIGN_DIR)" && for f in $(RELEASE_FILES) SHA256SUMS; do \
	  if cosign sign-blob --yes --bundle "$$f.sigstore.json" "$$f" >/dev/null; then echo "  signé $$f"; continue; fi; \
	  echo "  signature par défaut refusée pour $$f : nouvel essai via Rekor v2 ($(notdir $(SIGN_FALLBACK_CONFIG)))" >&2; \
	  rm -f "$$f.sigstore.json"; \
	  cosign sign-blob --yes --signing-config "$(SIGN_FALLBACK_CONFIG)" --bundle "$$f.sigstore.json" "$$f" >/dev/null || exit 1; \
	  echo "  signé $$f (Rekor v2)"; \
	done

verify-signatures: ## Vérifie chaque signature de DIR (dist par défaut) pour le tag edge-setup/$(VERSION), puis SHA256SUMS
	@if [[ ! "$(VERSION)" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$$ ]]; then echo "VERSION=$(VERSION) : vX.Y.Z requis" >&2; exit 2; fi
	@command -v cosign >/dev/null || { echo "cosign absent : https://docs.sigstore.dev/cosign/system_config/installation/" >&2; exit 2; }
	@dir="$${DIR:-dist}"; cd "$$dir"; for f in SHA256SUMS $(RELEASE_FILES); do \
	  cosign verify-blob --bundle "$$f.sigstore.json" \
	    --certificate-identity "$(SIGNER_PREFIX)$(VERSION)" \
	    --certificate-oidc-issuer "$(SIGNER_ISSUER)" "$$f" >/dev/null 2>&1 \
	    || { echo "signature invalide : $$dir/$$f (identité attendue $(SIGNER_PREFIX)$(VERSION))" >&2; exit 1; }; \
	done; \
	if command -v sha256sum >/dev/null; then sha256sum --check --quiet SHA256SUMS; else shasum -a 256 --check --quiet SHA256SUMS; fi
	@printf '$(C_OK)[make]$(C_RESET) %s : signatures et sommes vérifiées pour edge-setup/%s\n' "$${DIR:-dist}" "$(VERSION)"

fetch-signed: ## Télécharge les artefacts signés par la CI du tag edge-setup/$(VERSION) dans SIGNED_DIR et les vérifie (gh, cosign)
	bash scripts/fetch-signed-release.sh "$(VERSION)" "$(SIGNED_DIR)"
	@$(MAKE) --no-print-directory verify-signatures VERSION="$(VERSION)" DIR="$(SIGNED_DIR)"

publish: publish-check contract-check ## Publie la release $(VERSION) signée par la CI sur l'origine publique R2 (releases.openedbot.app) ; CLOUDFLARE_API_TOKEN et CF_ACCOUNT_ID requis
	@$(MAKE) --no-print-directory fetch-signed VERSION="$(VERSION)"
	bash scripts/publish-r2.sh "$(VERSION)" "$(SIGNED_DIR)"

# ─── Deployment ──────────────────────────────────────────────────────────────

deploy-host: ## (interne) échoue si HOST est vide, avant toute compilation
	@if [[ -z "$(HOST)" ]]; then echo "HOST manquant : make deploy HOST=user@host"; exit 2; fi

# La clé de déploiement partagée poste/VPS : `upgrade --from` n'accepte qu'un
# binaire tagué HMAC-SHA256 sous cette clé (edge-setup deploy-key set).
# Chemin canonique depuis le renommage en edge-setup ; un poste qui n'a que l'ancien chemin
# (créé avant le renommage) continue de le lire sans y toucher.
DEPLOY_KEY_FILE ?= $(shell d="$(HOME)/.config/edge-setup/deploy.key"; l="$(HOME)/.config/hermes-setup/deploy.key"; if [[ -f "$$d" || ! -f "$$l" ]]; then echo "$$d"; else echo "$$l"; fi)

deploy-key-check: ## (interne) refuse de déployer sans clé de déploiement locale
	@if [[ ! -f "$(DEPLOY_KEY_FILE)" ]]; then \
	  printf '$(C_ERR)[make]$(C_RESET) clé de déploiement absente : $(DEPLOY_KEY_FILE)\n'; \
	  printf '  la créer :   mkdir -p "$$(dirname "$(DEPLOY_KEY_FILE)")" && (umask 077; openssl rand -hex 32 > "$(DEPLOY_KEY_FILE)")\n'; \
	  printf '  puis sur le VPS (stdin, jamais en argument) :   ssh -t HOST sudo edge-setup deploy-key set < "$(DEPLOY_KEY_FILE)"\n'; \
	  exit 2; \
	fi
	@key="$$(tr -d '[:space:]' < "$(DEPLOY_KEY_FILE)")"; \
	  if [[ ! "$$key" =~ ^[0-9a-fA-F]{64}$$ ]]; then printf '$(C_ERR)[make]$(C_RESET) $(DEPLOY_KEY_FILE) doit contenir 64 caractères hexadécimaux (openssl rand -hex 32)\n'; exit 2; fi

deploy: deploy-host deploy-key-check ## Détecte l'architecture de HOST, pousse le binaire tagué (HMAC, clé de déploiement) puis lance `upgrade --yes --from --tag`
	@$(MAKE) --no-print-directory build-all
	@machine="$$(ssh "$(HOST)" 'LC_ALL=C uname -m')"; \
	  case "$$machine" in \
	    x86_64|amd64) arch=amd64 ;; \
	    aarch64|arm64) arch=arm64 ;; \
	    *) echo "architecture distante non prise en charge : $$machine" >&2; exit 2 ;; \
	  esac; \
	  asset="edge-setup_linux_$$arch"; \
	  sum="$$(awk -v asset="$$asset" '$$2 == asset {print $$1; exit}' dist/SHA256SUMS)"; \
	  if [[ ! "$$sum" =~ ^[0-9a-f]{64}$$ ]]; then echo "dist/SHA256SUMS ne liste pas $$asset" >&2; exit 1; fi; \
	  key="$$(tr -d '[:space:]' < "$(DEPLOY_KEY_FILE)" | tr 'A-F' 'a-f')"; \
	  tag="$$(printf 'hermes-setup upgrade v1\n%s\n' "$$sum" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$$key" | sed 's/^.*= *//')"; \
	  if [[ ! "$$tag" =~ ^[0-9a-f]{64}$$ ]]; then echo "openssl n'a pas produit de tag HMAC" >&2; exit 1; fi; \
	  remote="/tmp/$$asset"; \
	  scp "dist/$$asset" "$(HOST):$$remote"; \
	  ssh "$(HOST)" chmod 700 "$$remote"; \
	  ssh -t "$(HOST)" sudo "$$remote" upgrade --yes --from "$$remote" --tag "$$tag"; \
	  ssh -t "$(HOST)" sudo edge-setup status

# ─── Check ───────────────────────────────────────────────────────────────────

fmt: ## gofmt -l : échoue si un fichier n'est pas formaté
	@out="$$(gofmt -l .)"; if [[ -n "$$out" ]]; then echo "$$out"; exit 1; fi

# The macOS-only files (*_darwin.go: device keys, A2A listener) build only under
# GOOS=darwin, so the host vet never sees them. Vet them cross-compiled, without
# cgo like build-all, for each architecture we ship.
vet: ## go vet de l'hôte, puis de darwin amd64 et arm64 en compilation croisée (le code macOS n'est vérifié que là)
	go vet ./...
	@for arch in $(ARCHES); do \
	  CGO_ENABLED=0 GOOS=darwin GOARCH=$$arch go vet ./... \
	    || { printf '$(C_ERR)[make]$(C_RESET) go vet a échoué pour darwin/%s\n' "$$arch"; exit 1; }; \
	done
	@printf '$(C_OK)[make]$(C_RESET) go vet : hôte puis $(addprefix darwin/,$(ARCHES))\n'

LINT_STRICT ?= 0

# Outils d'analyse épinglés : version exacte et somme h1 du module (celle de
# sum.golang.org, que `go install` vérifie déjà au téléchargement). La CI
# installe ces versions par `make lint-tools`, qui relit ensuite la somme
# inscrite dans chaque binaire (`go version -m`) : un outil d'une autre
# version ou d'une autre source fait échouer la cible. Monter une version :
# changer la version ET la somme (curl https://sum.golang.org/lookup/<module>@<version>).
STATICCHECK_VERSION ?= v0.8.2
STATICCHECK_SUM ?= h1:+jPbCzuYxYrcoOvCecYUFDj+XJQRmzIhJmlbpps21Zk=
GOVULNCHECK_VERSION ?= v1.9.0
GOVULNCHECK_SUM ?= h1:12VaqnI9kJfqwRoPptxoqsUhQtdfrSbdksT7X/KY/sc=
LINT_TOOLS = staticcheck:honnef.co/go/tools:honnef.co/go/tools/cmd/staticcheck:$(STATICCHECK_VERSION):$(STATICCHECK_SUM) govulncheck:golang.org/x/vuln:golang.org/x/vuln/cmd/govulncheck:$(GOVULNCHECK_VERSION):$(GOVULNCHECK_SUM)

lint-tools: ## Installe staticcheck et govulncheck aux versions épinglées, puis vérifie la somme h1 de chaque binaire
	@set -e; for spec in $(LINT_TOOLS); do \
	  IFS=: read -r tool mod pkg version sum <<< "$$spec"; \
	  go install "$$pkg@$$version"; \
	  bin="$$(go env GOBIN)"; bin="$${bin:-$$(go env GOPATH)/bin}/$$tool"; \
	  got="$$(go version -m "$$bin" | awk -v m="$$mod" '$$1 == "mod" && $$2 == m { print $$3 " " $$4 }')"; \
	  if [[ "$$got" != "$$version $$sum" ]]; then printf '$(C_ERR)[make]$(C_RESET) %s : attendu %s %s, binaire %s\n' "$$tool" "$$version" "$$sum" "$${got:-illisible}" >&2; exit 1; fi; \
	  printf '$(C_OK)[make]$(C_RESET) %s %s (%s)\n' "$$tool" "$$version" "$$sum"; \
	done

lint: fmt vet ## fmt + vet ; staticcheck et govulncheck s'ils sont installés (LINT_STRICT=1 : requis aux versions épinglées, comme en CI)
	@for spec in $(LINT_TOOLS); do \
	  IFS=: read -r tool mod pkg version sum <<< "$$spec"; \
	  if command -v $$tool >/dev/null; then \
	    got="$$(go version -m "$$(command -v $$tool)" | awk -v m="$$mod" '$$1 == "mod" && $$2 == m { print $$3 }')"; \
	    if [[ "$$got" != "$$version" ]]; then \
	      if [[ "$(LINT_STRICT)" == 1 ]]; then echo "$$tool $${got:-?} au lieu de $$version (LINT_STRICT=1) : make lint-tools"; exit 2; fi; \
	      echo "$$tool $${got:-?} au lieu de $$version épinglé (make lint-tools pour aligner)"; \
	    fi; \
	    echo "== $$tool"; $$tool ./... || exit 1; \
	  elif [[ "$(LINT_STRICT)" == 1 ]]; then echo "$$tool absent (LINT_STRICT=1) : make lint-tools"; exit 2; \
	  else echo "$$tool absent, ignoré (LINT_STRICT=1 pour l'exiger ; make lint-tools pour l'installer)"; fi; \
	done

test: ## Tests unitaires, hors ligne
	go test ./...

shellcheck: ## shellcheck -S style sur le bootstrap et chaque script de edge-setup/ (SHELLCHECK=... pour une image docker)
	bash scripts/shellcheck.sh

test-release: ## Vérifie matrice, alias et checksums, l'ordre et l'immutabilité de la publication R2, et l'identité exacte exigée par l'installeur (hors ligne)
	bash test/release/build-all.sh
	bash test/release/publish-r2.sh
	bash test/release/notes-check.sh
	bash test/release/install-identity.sh
	bash test/release/sign-fallback.sh

contract-check: ## Contrat du lien des deux côtés : la cible de la racine du monorepo (OPENEDBOT_MAIN_DIR), sur cet arbre
	@if [[ ! -f "$(OPENEDBOT_MAIN_DIR)/Makefile" ]]; then printf '$(C_ERR)[make]$(C_RESET) dépôt openedbot introuvable : %s (racine du monorepo OpenedBot/openedbot, ou OPENEDBOT_MAIN_DIR=...)\n' "$(OPENEDBOT_MAIN_DIR)"; exit 2; fi
	@# A checkout from before the extraction ignores EDGE_SETUP_DIR and would
	@# compare its own host/edge-setup copy: a green that proves nothing.
	@if [[ -e "$(OPENEDBOT_MAIN_DIR)/host/edge-setup/go.mod" ]] || ! grep -q '^EDGE_SETUP_DIR ?=' "$(OPENEDBOT_MAIN_DIR)/Makefile"; then printf '$(C_ERR)[make]$(C_RESET) %s précède l'"'"'extraction (host/edge-setup présent ou EDGE_SETUP_DIR ignoré) : il ne testerait pas cet arbre\n' "$(OPENEDBOT_MAIN_DIR)"; exit 2; fi
	$(MAKE) -C "$(OPENEDBOT_MAIN_DIR)" contract-check EDGE_SETUP_DIR="$(CURDIR)"

test-update: ## Régénère les goldens (à relire dans le diff)
	go test ./internal/render/ -update

check: lint test test-release ## Tout ce qui doit être vert avant un commit

integration: build ## Tests d'intégration dans un conteneur Debian 13 + systemd (réseau requis)
	go test -tags integration ./test/integration/...

integration-vm: build ## up complet dans une VM QEMU Debian 13 (docker rootless, cgroups)
	bash test/vm/run.sh

# ─── Documentation ───────────────────────────────────────────────────────────

docs-dev: ## Site de documentation docs/ du monorepo (Astro Starlight, DOCS_DIR)
	cd "$(DOCS_DIR)" && DOCS_SCOPE=all bun run dev

check-docs: ## Vérifie que le site (DOCS_DIR, docs/ du monorepo) ne diverge pas de docs/ (blocs de commandes, étapes numérotées, sections) ni de l'allowlist du connecteur
	OPENEDBOT_DOCS_DIR="$(abspath $(DOCS_DIR))" go test ./internal/docs -count=1

docs-build: ## Construit le site de documentation (docs/ du monorepo)
	cd "$(DOCS_DIR)" && bun run build

# ─── Cleanup ─────────────────────────────────────────────────────────────────

clean: ## Supprime les artefacts de compilation locaux
	rm -rf dist $(SIGNED_DIR)

# ─── Help ────────────────────────────────────────────────────────────────────

help: ## Affiche cette aide, groupée par section
	@printf "$(C_SECTION)edge-setup$(C_RESET)\n"
	@awk -v S="$(C_SECTION)" -v T="$(C_TARGET)" -v R="$(C_RESET)" ' \
		/^# ─── / { pending=$$0; sub(/^# ─── /, "", pending); sub(/ ─+$$/, "", pending); next } \
		/^[a-zA-Z0-9_\\:-]+:.*## / { \
			if (pending != "") { printf "\n%s%s%s\n", S, pending, R; pending="" } \
			split($$0, a, "## "); name=a[1]; sub(/:[^:]*$$/, "", name); gsub(/\\/, "", name); \
			printf "  %s%-18s%s %s\n", T, name, R, a[2] } \
	' $(MAKEFILE_LIST)
