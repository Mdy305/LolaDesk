#!/bin/sh
# Launch-readiness tests: booking engine, public widget, Telnyx voice tools,
# Stripe webhook, OAuth/voice guards. In-memory database, no network.
cd "$(dirname "$0")/../.." || exit 1
fail=0
for t in engine telnyx stripe misc revenue firstrun links paywall reports voice relay growth jarvis tenants assistant frontdesk account legal ears onelola backbone zapier linkbook status voicefix smartbook signup findlola landing marketer setup owner-calendar public-booking dynvars telnyxdocs telecomsetup channels isolation setupwiring voicerelay phoneline bookhonest convreport boulevard onebrain sitewidget security2 callsfix bookingfix moneyfix uxfix noshow; do
  echo "── $t"
  out=$(node --import ./tests/launch/loader.mjs "./tests/launch/$t.test.mjs" 2>&1); code=$?
  printf '%s\n' "$out" | grep -v '^\['
  [ "$code" -eq 0 ] || fail=1
done
exit $fail
