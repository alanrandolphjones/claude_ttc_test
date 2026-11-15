# TTC Stop Map

A single-page map of every TTC bus and streetcar stop.

- **Map:** [Leaflet](https://leafletjs.com/) with OpenStreetMap tiles (no API key needed).
- **Data:** loaded live in the browser from the TTC's public real-time feed
  (`retro.umoiq.com`, the Umo IQ / NextBus API): the route list, then each route's stops.
- **Next vehicle:** tapping a stop shows live arrival predictions for each route and
  direction (next three vehicles), refreshed every 30 seconds while the popup is open.
- **Detours and closures:** the page cross-checks every stop against TTC service alerts from
  two feeds: live incidents (`alerts.ttc.ca`) and GTFS-realtime alerts (`gtfsrt.ttc.ca`),
  which add planned service changes such as construction diversions, replacement buses and
  parade detours. Live incidents list the exact stop numbers a detour or closure skips,
  so when you tap an affected stop it:
  - says the route isn't stopping there and crosses out the arrival times for that route
    and direction (the prediction feed keeps predicting at skipped stops);
  - suggests the closest existing stop on the detour streets (taken from the alert text,
    e.g. "Detour via Ossington Ave and Dundas St West") and the nearest stop where the
    route still stops normally, with walking distance;
  - shows replacement or shuttle bus information when the alert mentions it, and tags
    buses running on a streetcar route with **BUS**.
  Affected stops get an orange ring on the map.
- **Planned service changes:** shown on every stop of the affected route, with the TTC's
  details and a link to the advisory. Changes starting in the next two weeks show as upcoming.
- **"Does my direction stop here?":** when a route has a current service change and no stop
  for one of its directions near the stop you tapped (e.g. westbound 506 at Yonge & College
  while streetcars divert via Dundas), the popup says so and lists the nearest stops for that
  direction, streetcar and replacement bus separately, with walking distance. This uses the
  live route data, which already includes the detour, so it works even when an alert doesn't
  name stops.
- **Bus vs streetcar:** the live feed doesn't label vehicle type, so the streetcar route
  list in `index.html` (`STREETCAR_ROUTES`) is taken from the TTC's GTFS schedule data
  (Toronto Open Data, `routes.txt` where `route_type = 0`).

## Run it

Needs Node.js 18 or newer, no packages to install:

```sh
node server.js
# then open http://localhost:8000   (set PORT to change the port)
```

`server.js` serves the page and relays TTC service alerts at `/api/alerts`: it merges the
live and GTFS-realtime feeds, removes duplicates, and caches the result for 60 seconds. The relay is needed because the TTC's alerts feed doesn't allow browsers
to read it directly.

The page also runs from any static host (GitHub Pages, or `python3 -m http.server`), but
then there's no relay: stops and arrival times still work, and the page says detour info
is unavailable. For detour checking on a static host, run the relay somewhere (any Node
host, or port it to a serverless function) and point `ALERTS_URL` in `index.html` at it.
