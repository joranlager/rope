# Rope

A single-page map that shows your GPS position and the positions of people you trust,
with live distances in metres, terrain heights from Kartverket's hoydedata, and routing.

## Run

Requires Node 20 or newer. No npm install is needed; the server has no dependencies.

```bash
npm start          # http://localhost:8080
npm test           # unit tests for distance and the privacy rules
```

Environment variables (all optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `DATA_FILE` | `data/store.json` | Where users, contacts and grants are saved. Positions are kept in memory only. |
| `ROUTING_CAR` | OSRM demo, driving | Base URL for car routing (OSRM `route/v1` API) |
| `ROUTING_FOOT` / `ROUTING_BIKE` | unset | Enable walk / bike routing by pointing at your own OSRM (or compatible) server |
| `ELEVATION_URL` | `https://ws.geonorge.no/hoydedata/v1/punkt` | Kartverket hoydedata point service |

Browsers only give GPS on `https://` or `localhost`. Put the app behind TLS before using it on a phone.

## How it works

- **Map:** MapLibre GL with Kartverket's topographic raster tiles (`© Kartverket`).
- **Position:** the browser's `watchPosition`. Pings go to the server about every 2 seconds.
- **Heights:** the server proxies hoydedata (`koordsys=4258`) and caches results. The app shows
  terrain height at your position and an elevation profile with ascent and descent for each route.
- **Routing:** OSRM. The demo server only has the car profile, so walk and bike need your own instance.
- **Distance:** straight-line (haversine) in metres, recomputed as positions update.

## Contacts and secrets

- Each person has a **reusable contact code** (`<userId>.<secret>`). Paste someone's code to connect.
  Connecting is mutual and idempotent.
- **Rotate code** invalidates the old secret. Existing contacts stay.
- Nicknames are local to each person, so you can name a contact differently from their own name.

## Visibility and admin rights

- Each person can turn **Share my position** off. Contacts then see them as hidden.
- An **admin grant** is directional: when A makes B their admin, A can see B's position even
  when B's sharing is off.
- Only the admin can create or remove a grant. The subject gets `403` if they try to revoke it,
  remove the contact, or change it. The subject can see that the grant exists (`adminsOverMe`)
  and that their toggle is overridden.
- These rules are enforced in `server/store.js`, not in the browser.

## Layout

```
server/index.js    entry point
server/app.js      HTTP routes, static files, hoydedata proxy, CSP headers
server/store.js    users, contacts, grants, visibility and privacy rules
public/index.html  single page
public/app.js      map, GPS, people, routing, elevation profile
public/geo.js      haversine and elevation helpers (shared with tests)
test/              node:test unit tests
```

## Known limitations and things to verify

- **Live APIs not yet exercised.** The build environment could not reach Kartverket, Geonorge
  or the map CDN, so the tile URL, the hoydedata response shape (`punkter[0].z`) and the
  OSRM responses are written from documentation and not checked against live responses.
  Run it once on your machine and check the Heights and route profile.
- **Identity** is a bearer token kept in `localStorage`. Clearing site data loses the account
  unless you have saved the code. Add real sign-in before using this outside a trusted group.
- **Consent:** whoever holds your code can connect to you and, once connected, can be made
  admin over you by the other party only with a grant that you can see but not remove. Treat
  codes like invitations.
- **Subresource integrity** is not set on the MapLibre `<script>`/`<link>` tags. Add `integrity`
  hashes if you host it publicly.
- **Positions are in memory.** Restarting the server clears live positions, though not accounts.
