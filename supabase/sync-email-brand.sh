#!/bin/sh
# Copy the shared JAG email design into every function that sends email (each deploys its own copy).
cd "$(dirname "$0")/functions" || exit 1
for f in jag-msg-notify jag-offer-tc lead-emails listing-alerts jag-client-email jag-invest jag-client-hub; do cp _shared/jag-email.ts "$f/jag-email.ts"; done
echo "synced"
