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
- **Corner labels:** stops on opposite corners often share a name ("Bay St at College St").
  Each stop is labelled with its corner ("southeast corner, northbound"), worked out from the
  direction vehicles travel through it and where it sits relative to the other stops at that
  intersection. Mid-block stops get the side of the street.
- **Detour paths:** drawn as dashed lines from the TTC's GTFS-realtime detour feed
  (`gtfsrt.ttc.ca/trips/detour`), trimmed to the part that leaves the route's scheduled path
  (from the published GTFS schedule). Orange = running today, purple = planned.
- **Out-of-service stops:** while a stop is out of service the TTC removes it from its live
  data and schedule, so the regular stop just disappears. The server fetches TTC stops from
  OpenStreetMap once a day (Overpass API); where a mapped stop has no live stop and a route
  with a service change is missing a direction there, the page shows it as a grey dashed
  "not in service" stop with where to board instead.
- **Route lines:** every route is drawn from the TTC's live route data (via `/api/network`,
  about 75 KB, rebuilt hourly), so the map follows routing changes the TTC has put into
  service; replacement-bus branches are drawn as bus lines. Short-term detours the live data
  doesn't reflect show as the TTC's dashed detour paths on top. Tap a line, a route chip in a stop popup, or pick from the route list to highlight
  that route: its live path is drawn bold, with parts off the regular route in orange and
  parts of the regular route not served in grey dots, plus any TTC detour path. Where several
  routes share a street, a tap asks which one. For streetcar routes the regular route comes
  from OpenStreetMap (tracks are carefully mapped, and the TTC writes long-running diversions
  into its schedule, so the schedule can't show them); replacement-bus branches are drawn
  separately, and the card says where the regular route has no streetcar but the bus covers
  it. For bus routes, whose OSM mapping is patchier, "off the regular route" means off both
  OSM and the schedule.
- **Streetcar vs replacement bus at a stop:** stops are coloured and labelled by the branches
  that actually serve them (e.g. "506 bus" at Yonge & College), and the "doesn't stop here"
  check works per direction and per mode.
- **Exact detour stops:** the server reads the TTC's trip updates for detoured trips
  (`gtfsrt.ttc.ca/trips/modified_update`, every 90 s, `/api/detour-stops`), which list each
  detoured trip's stops with predicted times. Stops a detour serves that aren't on the route's
  regular stop list get a dashed orange ring and a "The 95 detour stops here" box with times;
  skipped stops name the first stop the detoured trips actually serve and list the rest.
- **Route lines follow alerts:** routes with an active alert are rebuilt every 10 minutes and
  as soon as their alerts change; the page re-fetches the route map when alerts change.
- **Bus vs streetcar:** the live feed doesn't label vehicle type, so the streetcar route
  list in `index.html` (`STREETCAR_ROUTES`) is taken from the TTC's GTFS schedule data
  (Toronto Open Data, `routes.txt` where `route_type = 0`).

## OpenStreetMap snapshot

Out-of-service stops and the regular-route comparison use OpenStreetMap data. Public
Overpass servers often refuse or time out from cloud hosts, so a GitHub Actions workflow
(`.github/workflows/osm-snapshot.yml`) fetches TTC stops and route relations weekly (or on
demand: Actions → OpenStreetMap snapshot → Run workflow) and commits them to `osm/`. The
server reads those files and only queries Overpass live if they're missing or older than
30 days. OSM data © OpenStreetMap contributors, ODbL.

## Feed-disagreement observer

The TTC's sources don't always agree: an alert may say stops are skipped while the live feed
still predicts arrivals there, or the alert text and the live route data may describe
different routings. To learn which source to believe, the server checks every route with a
service change every 5 minutes and records where vehicles actually are against:

- the live route data (what drives arrival predictions),
- the scheduled path (published GTFS),
- the detour feed's path,
- and, for stops an alert says are skipped, whether the live feed still predicts there and
  whether any vehicle was seen at them.

Observations go to `data/observations/YYYY-MM-DD.jsonl`. See the findings with
`node report.js [days]` (add `--now` to run a check first) or at `/api/observations?days=N`.
"Likely ghost times" means a skipped stop kept getting predictions for at least an hour with
no vehicle ever seen there.

## Run it

Needs Node.js 18 or newer, no packages to install:

```sh
node server.js
# then open http://localhost:8000   (set PORT to change the port)
```

`server.js` serves the page plus:

- `/api/alerts`: TTC service alerts, merging the live and GTFS-realtime feeds (cached 60 s),
- `/api/detours`: detour paths (cached 5 min),
- `/api/osm-stops`: OpenStreetMap stops near routes with service changes (refreshed daily),
- `/api/network`: all bus and streetcar route lines, `/api/route?r=N`: one route's live path
  and its differences from the regular route,
- `/api/observations`: the observer's findings.

On first start it downloads the TTC's published schedule (about 30 MB, refreshed daily) into
`data/` to know each route's normal path. Set `OBSERVE=0` to turn the observer off. The relay is needed because the TTC's alerts feed doesn't allow browsers
to read it directly.

The page also runs from any static host (GitHub Pages, or `python3 -m http.server`), but
then there's no relay: stops and arrival times still work, and the page says detour info
is unavailable. For detour checking on a static host, run the relay somewhere (any Node
host, or port it to a serverless function) and point `ALERTS_URL` in `index.html` at it.

## Deploy

Any host that runs Node.js 20+ as an always-on process with a persistent disk works. The
server needs no build step and no packages; hosts detect it from `package.json`
(`npm start`).

Settings:

| Variable | Purpose |
|---|---|
| `PORT` | Set by most hosts automatically. |
| `DATA_DIR` | Where the schedule download and observations are kept. Point it at a persistent volume (e.g. `/data`). |
| `OBSERVE=0` | Optional: turn the feed-disagreement observer off. |

Health check path: `/healthz`.

### Railway

1. New project → Deploy from GitHub repo → pick this repo and branch.
2. Add a volume to the service, mounted at `/data`.
3. Variables: `DATA_DIR=/data`.
4. Settings → Networking → Generate domain. Health check path: `/healthz`.
