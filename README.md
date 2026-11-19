# Rope

A single-page web app with no backend of its own. It shows your GPS position on an
OpenStreetMap map, shares live positions with a circle of trusted people, shows the distance to
each of them in metres, adds terrain heights from hoydedata, and plans routes.

It is plain static files, so it runs on GitHub Pages.

```bash
npm start      # http://localhost:8080 (local static server)
npm test       # crypto, visibility/admin rules, distance
npm run build  # copies public/ to dist/
```

Browsers only give GPS and WebCrypto on `https://` or `localhost`.

## How people find each other without a backend

People can't connect directly without something to meet on. Rope uses a **rendezvous server**:
a public [ntfy](https://ntfy.sh) publish/subscribe relay (default `https://ntfy.sh`). It is not
ours and holds no accounts. It sees topic names and ciphertext only. You can point Rope at your
own ntfy server under **Me → Rendezvous server**. Everyone in a circle must use the same one.

1. **Identity.** On first run your browser creates two keys (ECDH for pairing, ECDSA for signing)
   and stores them in `localStorage`. Nothing is uploaded.
2. **Invite.** *Copy my invite link* gives a reusable link (`…#c=<card>`). The card holds your name
   and public keys. The part after `#` is never sent to a web server.
3. **Request.** The person who opens the link sends a request to your inbox topic on the
   rendezvous server. You see it with a security code and accept or decline.
4. **Per-contact secret.** On accept, both sides derive the same secret from their keys (ECDH).
   It gives each contact its own AES-GCM key and its own unguessable topic.
5. **Sharing.** Positions are encrypted and published to that contact's topic every 10 s.
   The rendezvous server only relays ciphertext.

## Following, trails and reload

- **Following:** the map opens following your own position. **Show** on a person follows them. Drag the
  map to stop. The arrow button (bottom right) resumes: after a drag it picks up what you were following,
  and while following someone it returns to you. The arrow is filled while following you.
- **Trails:** each person, you included, can have a trail of their last stretch of path, fading toward
  the oldest end. It is **off by default** and set per person: on/off, length (250 m to 5 km, default 1 km)
  and colour. A trail starts recording when you switch it on, lives only in memory on your device, and is
  removed if that person stops sharing. You can only trail people you are allowed to see.
- **Reload:** tap the **Rope** logo (top left) four times quickly to reload the app. A launch splash
  shows on a normal start; after a four-tap reload a shorter "Reloading" splash shows instead.

## Visibility and admin rights

- **Share my position** off: your client stops sending to everyone except your admins, and tells
  contacts you're hidden.
- **Admin:** *Make me admin* on a contact sends them a grant signed with your signing key.
  Their client then keeps sending to you even when they hide, and shows the grant as locked.
- The subject can't forge a revocation: grants are verified against the admin's public signing key,
  and stale or replayed grants are ignored. They can't remove the contact in the UI while it's in force.

### What this does and doesn't guarantee

With no server, the subject's own device decides what it sends. Rope makes the admin grant
unforgeable and sticky in the app, but **someone who modifies their client, clears their browser
data, or uses another device can stop sending**. Treat this as parental control among people who
use the app as intended, not as protection against a determined technical child. A tamper-proof
guarantee needs software the subject can't control, such as a managed device.

## Limits and things to verify

- **Not yet exercised against live services.** The build environment couldn't reach ntfy.sh,
  OpenStreetMap, Geonorge or the CDN. These need a check in a real browser: ntfy's `/sse` endpoint
  and CORS, the hoydedata response shape (`punkter[0].z`) and CORS, and the OSRM responses.
- The base map uses the public OpenStreetMap tile server, which is meant for light use under its
  [tile usage policy](https://operations.osmfoundation.org/policies/tiles/). For heavier use,
  switch to a tile provider or your own tile server.
- Public ntfy.sh is rate limited and keeps messages only for a limited time. Use your own server
  for regular use.
- Routing uses the OSRM demo server (car only). Walk and bike need a different routing service.
- Your private keys live only in this browser. Use **Me → Copy backup** and keep it secret.
- No SRI hashes on the MapLibre CDN tags yet.

## Layout

```
public/index.html  the single page (with a Content-Security-Policy meta tag)
public/app.js      UI, GPS, contacts, handshake, messaging, routing
public/crypto.js   keys, cards, ECDH/HKDF, AES-GCM, signatures
public/net.js      ntfy publish/subscribe
public/social.js   pure visibility and admin rules (unit tested)
public/geo.js      haversine, elevation helpers
public/follow.js   what the map is following (pure, tested)
public/trace.js    trails: trimming, jitter, colours (pure, tested)
public/boot.js     picks the splash before first paint
```

Every branch builds with `.github/workflows/pages.yml` and deploys to GitHub Pages. All branches
share one site, so the latest deploy wins.
