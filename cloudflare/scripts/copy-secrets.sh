#!/bin/bash
# Copies the function secrets from the Netlify site into the phillips-uk Worker. Values are never printed.
# Needs `npx netlify-cli login` and `npx wrangler login` first. Re-run after rotating a key.
set -e
cd "$(dirname "$0")/../.."
SITE_ID=fa46bc25-6932-4d64-b664-ee441fe69f27
VARS="ANTHROPIC_API_KEY OPENAI_API_KEY PSI_API_KEY CREATIVE_UPLOAD_PIN GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_OAUTH_CLIENT_ID OAUTH_REDIRECT_URI WORKER_URL WORKER_SECRET ALLOWED_AUDIT_EMAILS"
TMP=$(mktemp)
chmod 600 "$TMP"
trap 'rm -f "$TMP"' EXIT
echo '{}' > "$TMP"
# env:get reads the linked site; .netlify/ is git-ignored
[ -f .netlify/state.json ] || npx --yes netlify-cli link --id "$SITE_ID"
for v in $VARS; do
  val=$(npx --yes netlify-cli env:get "$v" 2>/dev/null || true)
  # `netlify env:get` prints a "No value set..." sentence (exit 0) for variables that do not exist; never copy that
  if printf '%s' "$val" | grep -qiE '^no value|not set|not found|no site'; then val=""; fi
  if [ -n "$val" ]; then
    printf '%s' "$val" | python3 -c 'import sys,json; p=sys.argv[1]; d=json.load(open(p)); d[sys.argv[2]]=sys.stdin.read(); json.dump(d,open(p,"w"))' "$TMP" "$v"
    echo "found $v"
  else
    echo "empty $v"
  fi
done
npx wrangler secret bulk "$TMP"
