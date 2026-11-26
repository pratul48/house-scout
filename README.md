# House Scout

A phone web app for house hunting. Type an address, or tap "I'm at the house", and it shows:

- **Which way the front of the house faces**, with a big ✔ OK / ✖ avoid verdict. South, South-East and South-West (112.5° to 247.5°) count as avoid.
  - It estimates the direction from the building outline and the street the address is on (OpenStreetMap data).
  - It warns about corner lots, streets behind the house, low-confidence results, and directions within 10° of the avoid zone.
  - You can confirm it with the phone's compass at the front door, or set it yourself.
- **Map** with satellite view. The front direction is drawn as an arrow, and you can tap a different roof to re-check.
- **Nearby, with driving distance and time:** Costco, Indian grocery, Hindu temple, Indian restaurant, supermarkets, hospital, urgent care, pharmacy, schools, parks, library, gym, gas, fire station, police, train station, airport, and your own saved places (work, family).
- **Noise and nuisances:** freeways, busy roads, railroads, power lines, industrial areas, landfills, cemeteries, airports.
- **Property:** county, elevation, FEMA flood zone, and stories/year built if they're on OpenStreetMap.
- **Roof age:** no free database has this, so the app gives direct links to listing text, city permit search and BuildZoom.
- **Research links:** Street View, Zillow, Redfin, Realtor.com, county records, GreatSchools, crime map, FEMA, climate risk, internet providers.
- **Saved houses** with your notes (price, roof year, HOA, HVAC, and so on). These stay on your phone in browser storage.

It needs no API keys or accounts. It uses free services: OpenStreetMap (Nominatim and Overpass), the OSRM demo router, Open-Meteo, FEMA NFHL, and Esri imagery.

## Put it on your phone

The app has to be served over **HTTPS**, because phone GPS and compass only work on secure pages. Any static host works:

- **GitHub Pages:** push this folder to a repo, then go to Settings → Pages → Deploy from branch.
- **Netlify Drop:** on a computer, drag the folder onto https://app.netlify.com/drop.

Open the URL on your phone, then add it to your home screen:
- **iPhone (Safari):** Share → Add to Home Screen
- **Android (Chrome):** ⋮ → Add to Home screen / Install app

## Accuracy notes

- The map estimate assumes the front door faces the street in the address. That holds for most houses, but not all. Check corner lots, houses on cul-de-sacs, and anything flagged as low or medium confidence with the compass or Street View.
- Phone compasses read magnetic north. Enter your local magnetic declination in the compass section ([NOAA calculator](https://www.ngdc.noaa.gov/geomag/calculators/magcalc.shtml#declination)) so readings are converted to true north.
- OpenStreetMap is missing many small Indian grocery stores. The app adds a Google Maps search link next to them.
