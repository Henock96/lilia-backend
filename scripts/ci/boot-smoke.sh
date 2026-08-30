#!/usr/bin/env bash
#
# Démarre réellement les deux processus et vérifie qu'ils vivent.
#
# POURQUOI CE SCRIPT EXISTE
#
# Le worker a été livré avec un graphe de dépendances invalide : il compilait,
# `npm run build` passait au vert, et le processus mourait au bootstrap
# (« Nest can't resolve dependencies of the RefundsController »). Ni `tsc`, ni
# les tests unitaires, ni le build ne pouvaient l'attraper — l'injection de
# dépendances se résout au démarrage, pas à la compilation.
#
# Un binaire qui compile n'est pas un binaire qui démarre. Ce script vérifie la
# seule chose qui compte vraiment avant un déploiement : que le processus se
# lève et réponde.
#
# Il contrôle aussi que le worker n'expose **aucune route métier**. Les
# `APP_GUARD` (authentification, rôles, throttling) vivent dans `AppModule` /
# `AuthModule`, absents de son graphe : tout controller qui y entrerait serait
# servi sans authentification sur son port.
#
# USAGE (local)
#   DATABASE_URL=... REDIS_URL=... ./scripts/ci/boot-smoke.sh
#
set -euo pipefail

WEB_PORT="${PORT:-8080}"
WORKER_PORT="${WORKER_PORT:-8081}"
LOG_DIR="$(mktemp -d)"
TIMEOUT_SECONDS="${BOOT_TIMEOUT_SECONDS:-60}"

web_pid=""
worker_pid=""

cleanup() {
  [ -n "$web_pid" ] && kill "$web_pid" 2>/dev/null || true
  [ -n "$worker_pid" ] && kill "$worker_pid" 2>/dev/null || true
}
trap cleanup EXIT

fail() {
  echo "❌ $1"
  echo "--- journal web ---";    tail -40 "$LOG_DIR/web.log"    2>/dev/null || true
  echo "--- journal worker ---"; tail -40 "$LOG_DIR/worker.log" 2>/dev/null || true
  exit 1
}

# Attend que /health réponde. On interroge le endpoint plutôt que de dormir un
# temps fixe : un `sleep 20` est à la fois trop long en local et trop court sur
# un runner chargé.
wait_for_health() {
  local name="$1" port="$2" pid="$3"
  for _ in $(seq 1 "$TIMEOUT_SECONDS"); do
    if ! kill -0 "$pid" 2>/dev/null; then
      fail "$name est mort pendant le démarrage."
    fi
    if curl -sf "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
      echo "✅ $name répond sur /health"
      return 0
    fi
    sleep 1
  done
  fail "$name n'a pas répondu en ${TIMEOUT_SECONDS}s."
}

echo "▶ Démarrage du worker…"
WORKER_PORT="$WORKER_PORT" node dist/apps/worker/main > "$LOG_DIR/worker.log" 2>&1 &
worker_pid=$!

echo "▶ Démarrage du service web…"
PORT="$WEB_PORT" node dist/apps/lilia-app/main > "$LOG_DIR/web.log" 2>&1 &
web_pid=$!

wait_for_health "Le worker" "$WORKER_PORT" "$worker_pid"
wait_for_health "Le service web" "$WEB_PORT" "$web_pid"

# ── Le worker ne doit servir aucune route métier ───────────────────────────────
#
# Nest journalise chaque route montée (« Mapped {/orders, GET} route »). On lit
# donc ce que le processus a réellement exposé, pas ce qu'on croit qu'il expose.
echo "▶ Vérification de la surface HTTP du worker…"
mapped=$(grep -oE 'Mapped \{[^}]*\}' "$LOG_DIR/worker.log" | sed -E 's/Mapped \{(.*)\}/\1/' || true)
unexpected=$(echo "$mapped" | grep -vE '^(/|/health), GET$' || true)

if [ -n "$unexpected" ]; then
  echo "❌ Le worker expose des routes métier, sans les guards globaux :"
  echo "$unexpected" | sed 's/^/    /'
  echo
  echo "   Corrigez en extrayant un module '*-core.module.ts' sans controller"
  echo "   (voir OrdersCoreModule, NotificationsCoreModule) plutôt qu'en"
  echo "   élargissant la liste autorisée."
  exit 1
fi

echo "✅ Le worker n'expose que ses routes de santé."
echo "✅ Les deux processus démarrent."
