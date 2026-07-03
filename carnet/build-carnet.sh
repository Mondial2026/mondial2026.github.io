#!/usr/bin/env bash
# Génère le Carnet du Mondial 2026 (PDF) à partir des données d'index.html.
# Portable macOS / Linux (GitHub Actions ubuntu-latest a google-chrome préinstallé).
# Usage : bash carnet/build-carnet.sh   (depuis la racine du dépôt)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/index.html"
TPL="$ROOT/carnet/carnet-template.html"
OUT_HTML="$ROOT/carnet/carnet-mondial-2026.html"
OUT_PDF="$ROOT/carnet-mondial-2026.pdf"   # à la racine : c'est le fichier servi au téléchargement

# Chrome : chemin macOS ou binaire Linux (surchargable via $CHROME)
if [ -z "${CHROME:-}" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           google-chrome google-chrome-stable chromium-browser chromium; do
    if [ -x "$c" ] || command -v "$c" >/dev/null 2>&1; then CHROME="$c"; break; fi
  done
fi
[ -n "${CHROME:-}" ] || { echo "ERREUR : Chrome/Chromium introuvable"; exit 1; }

# 1. Extraire le bloc DONNÉES (de "const LAST_UPDATE" jusqu'au commentaire MOTEUR DE RENDU)
DATA=$(mktemp)
awk '/^const LAST_UPDATE/{f=1} f&&/^\/\* ═/{f=0} f' "$SRC" > "$DATA"
grep -q "const NEWS" "$DATA" || { echo "ERREUR : extraction des données incomplète"; exit 1; }

# 2. Injecter dans le gabarit à la place du marqueur /*__DONNEES__*/
awk -v df="$DATA" '/\/\*__DONNEES__\*\//{while((getline l<df)>0)print l;next}1' "$TPL" > "$OUT_HTML"
rm -f "$DATA"

# 3. Valider le JavaScript du carnet
JSCHECK=$(mktemp).js
awk '/^<script>$/{f=1;next}/^<\/script>$/{f=0}f' "$OUT_HTML" > "$JSCHECK"
node --check "$JSCHECK" || { echo "ERREUR : JavaScript invalide"; exit 1; }
rm -f "$JSCHECK"

# 4. Générer le PDF (Chrome headless, format A4 défini par @page dans le CSS)
"$CHROME" --headless --disable-gpu --no-sandbox --no-pdf-header-footer \
  --virtual-time-budget=8000 \
  --print-to-pdf="$OUT_PDF" "file://$OUT_HTML" 2>/dev/null

echo "OK : $OUT_PDF"
ls -lh "$OUT_PDF"
