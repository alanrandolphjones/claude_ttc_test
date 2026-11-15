# TTC Stop Map

A single-page map of every TTC bus and streetcar stop.

- **Map:** [Leaflet](https://leafletjs.com/) with OpenStreetMap tiles (no API key needed).
- **Data:** loaded live in the browser from the TTC's public real-time feed
  (`retro.umoiq.com`, the Umo IQ / NextBus API): the route list, then each route's stops.
- **Next vehicle:** tapping a stop shows live arrival predictions for each route and
  direction (next three vehicles), refreshed every 30 seconds while the popup is open.
- **Bus vs streetcar:** the live feed doesn't label vehicle type, so the streetcar route
  list in `index.html` (`STREETCAR_ROUTES`) is taken from the TTC's GTFS schedule data
  (Toronto Open Data, `routes.txt` where `route_type = 0`).

## Run it

It's a static page. Serve the folder with any web server:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Or host it on GitHub Pages or any other static host.
