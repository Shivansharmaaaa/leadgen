#!/usr/bin/env bash
# Fetch the UCI Bank Marketing dataset used by `npm run train:real`.
# Moro et al., CC BY 4.0 — https://doi.org/10.24432/C5K306
set -euo pipefail
mkdir -p data
TMP=$(mktemp -d)
curl -sL -o "$TMP/bank.zip" "https://archive.ics.uci.edu/static/public/222/bank+marketing.zip"
unzip -oq "$TMP/bank.zip" -d "$TMP"
unzip -oq "$TMP/bank-additional.zip" -d "$TMP"
cp "$TMP/bank-additional/bank-additional-full.csv" data/bank-marketing.csv
rm -rf "$TMP"
echo "✓ data/bank-marketing.csv ($(wc -l < data/bank-marketing.csv) rows)"
