#!/usr/bin/env bash
# make sign must keep the default Sigstore path, fall back on the Rekor v2
# signing config only for a file whose default signature failed, and fail
# when the fallback fails too. A fake cosign stands in for Sigstore; the
# fallback config itself must name Rekor v2 and a timestamp authority.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd -P)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/edge-sign-test.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

config="$root/scripts/sigstore-signing-config-rekor-v2.json"
python3 - "$config" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
assert c["mediaType"] == "application/vnd.dev.sigstore.signingconfig.v0.2+json", c["mediaType"]
logs = c["rekorTlogUrls"]
assert logs and all(l["majorApiVersion"] == 2 and l["url"].startswith("https://") for l in logs), logs
assert c["tsaUrls"] and c["tsaUrls"][0]["url"] == "https://timestamp.sigstore.dev/api/v1/timestamp", c["tsaUrls"]
assert c["caUrls"][0]["url"] == "https://fulcio.sigstore.dev", c["caUrls"]
PY

mkdir -p "$tmp/bin" "$tmp/tree/dist"
# FAIL_DEFAULT: every default signature fails; FAIL_FALLBACK: the fallback too.
cat > "$tmp/bin/cosign" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_LOG"
bundle=""; fallback=0; file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle) bundle="$2"; shift 2 ;;
    --signing-config) fallback=1; shift 2 ;;
    sign-blob|--yes) shift ;;
    *) file="$1"; shift ;;
  esac
done
if [[ "$fallback" == 0 && "${FAIL_DEFAULT:-0}" == 1 ]]; then echo "rekor 500" >&2; printf partial > "$bundle"; exit 1; fi
if [[ "$fallback" == 1 && "${FAIL_FALLBACK:-0}" == 1 ]]; then echo "rekor v2 down" >&2; exit 1; fi
printf '{"signed":"%s","fallback":%d}\n' "$file" "$fallback" > "$bundle"
SH
chmod +x "$tmp/bin/cosign"

sign() {
  rm -f "$tmp/tree/dist/"*.sigstore.json "$tmp/log"
  for f in a b SHA256SUMS; do printf '%s' "$f" > "$tmp/tree/dist/$f"; done
  PATH="$tmp/bin:$PATH" FAKE_LOG="$tmp/log" make -s -C "$root" sign VERSION=v9.9.9 \
    RELEASE_FILES="a b" SIGN_FALLBACK_CONFIG="$config" SIGN_DIR="$tmp/tree/dist" \
    >"$tmp/out" 2>&1
}

# Default path: one call per file, no fallback.
sign || { cat "$tmp/out"; echo "sign-fallback test: default signing failed" >&2; exit 1; }
if [[ "$(wc -l < "$tmp/log")" -ne 3 ]] || grep -q -- --signing-config "$tmp/log"; then
  cat "$tmp/log"; echo "sign-fallback test: the default path used the fallback" >&2; exit 1
fi

# Default refused: each file is signed again through the Rekor v2 config,
# and the partial bundle of the failed attempt is not what is left.
FAIL_DEFAULT=1 sign || { cat "$tmp/out"; echo "sign-fallback test: the fallback did not sign" >&2; exit 1; }
[[ "$(grep -c -- "--signing-config $config" "$tmp/log")" -eq 3 ]] \
  || { cat "$tmp/log"; echo "sign-fallback test: fallback not used for every file" >&2; exit 1; }
for f in a b SHA256SUMS; do
  grep -q '"fallback":1' "$tmp/tree/dist/$f.sigstore.json" || { echo "sign-fallback test: $f bundle is not the fallback's" >&2; exit 1; }
done

# A missing directory fails instead of signing wherever make runs.
if PATH="$tmp/bin:$PATH" FAKE_LOG="$tmp/log" make -s -C "$root" sign VERSION=v9.9.9 RELEASE_FILES="a" SIGN_DIR="$tmp/absent" >"$tmp/out" 2>&1; then
  echo "sign-fallback test: signed without its directory" >&2; exit 1
fi
[[ -z "$(find "$root" -maxdepth 1 -name '*.sigstore.json' -newer "$config" 2>/dev/null)" ]] || { echo "sign-fallback test: a bundle was written outside the directory" >&2; exit 1; }

# Both refused: make sign fails.
if FAIL_DEFAULT=1 FAIL_FALLBACK=1 sign; then echo "sign-fallback test: signed with every log down" >&2; exit 1; fi
echo "sign-fallback test: OK"
