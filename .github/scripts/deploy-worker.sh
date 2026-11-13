#!/usr/bin/env bash
# One-click backend deploy: creates the D1 database and R2 bucket if missing, applies migrations,
# deploys the Worker and syncs secrets from GitHub → Cloudflare. Safe to run repeatedly.
set -eo pipefail
cd worker
npm ci --no-audit --no-fund || npm install --no-audit --no-fund
W="npx wrangler"
CFG=wrangler.deploy.toml
cp wrangler.toml "$CFG"

find_db() { $W d1 list --json 2>/dev/null | node -e "const l=JSON.parse(require('fs').readFileSync(0,'utf8')||'[]');const d=l.find(x=>x.name==='screation');process.stdout.write(d?(d.uuid||d.database_id||''):'')"; }
DBID=$(find_db || true)
if [ -z "$DBID" ]; then echo "Creating D1 database 'screation'…"; $W d1 create screation >/dev/null; DBID=$(find_db); fi
sed -i "s/REPLACE_WITH_D1_DATABASE_ID/$DBID/" "$CFG"
echo "D1: $DBID"

if ! $W r2 bucket list 2>/dev/null | grep -q "screation-media"; then
  if ! $W r2 bucket create screation-media; then
    echo "::notice title=Photos stored in GitHub::Cloudflare R2 is not enabled, so product photos will be committed to this repo (needs the PUBLISH_TOKEN secret). That is fine on the free plan."
    python3 - "$CFG" <<'PY'
import sys,re; p=sys.argv[1]; s=open(p).read(); s=re.sub(r'\[\[r2_buckets\]\][^\[]*', '', s); open(p,'w').write(s)
PY
  fi
fi

if [ "${CUSTOM_DOMAIN:-}" != "true" ]; then sed -i '/^routes = /d' "$CFG"; fi
sed -i "s#^GITHUB_REPO = .*#GITHUB_REPO = \"${GITHUB_REPOSITORY}\"#" "$CFG"
[ -n "${SITE_URL:-}" ] && sed -i "s#^SITE_URL = .*#SITE_URL = \"${SITE_URL}\"#" "$CFG"

$W d1 migrations apply screation --remote -c "$CFG"
# Cloudflare occasionally returns transient API errors (e.g. code 10013): retry up to 3 times.
for i in 1 2 3; do
  if $W deploy -c "$CFG" | tee /tmp/deploy.log; then break; fi
  [ "$i" = 3 ] && exit 1
  echo "Deploy attempt $i failed; retrying in 20s…"; sleep 20
done
URL=$(grep -oE 'https://[a-z0-9.-]+\.workers\.dev' /tmp/deploy.log | head -1 || true)

EXISTING=$($W secret list -c "$CFG" --format json 2>/dev/null || echo '[]')
has() { echo "$EXISTING" | grep -q "\"$1\""; }
put() { printf '%s' "$2" | $W secret put "$1" -c "$CFG" >/dev/null && echo "secret $1 ✓"; }
has SESSION_SECRET || put SESSION_SECRET "$(openssl rand -hex 32)"
[ -n "${ADMIN_SETUP_TOKEN:-}" ] && put SETUP_TOKEN "$ADMIN_SETUP_TOKEN"
[ -n "${PUBLISH_TOKEN:-}" ] && put GITHUB_TOKEN "$PUBLISH_TOKEN"
for n in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET PAYPAL_CLIENT_ID PAYPAL_CLIENT_SECRET PAYPAL_WEBHOOK_ID DHL_API_KEY DHL_API_SECRET DHL_ACCOUNT_NUMBER GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET RESEND_API_KEY EMAIL_FROM; do
  v="${!n:-}"; [ -n "$v" ] && put "$n" "$v"
done
echo "### API deployed" >> "$GITHUB_STEP_SUMMARY"
echo "API URL: ${URL:-https://api.screationindia.in}" >> "$GITHUB_STEP_SUMMARY"
