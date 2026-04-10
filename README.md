# Embedding Explorer

Interactive tools for navigating image and text embedding spaces.

## Pages

- **`index.html`** — landing page with links to the two viewers.
- **`viewer.html`** — 3D WebGL viewer (desktop). Explore embeddings with mouse
  or a MIDI controller (nanoKONTROL2, CC 16/17/18 → X/Y/Z). Hover points to
  preview their image and text. Blend mode composites all in-range images by
  distance and position.
- **`geo.html`** — mobile geo viewer. Maps the embedding space onto a physical
  location; your phone's GPS becomes the cursor and tilt scans the depth axis.
  Haptic + audio cues fire when you enter an image zone.

## Data format

Each dataset is a JSON array of points:

```json
[
  { "x": 0.12, "y": -0.4, "z": 0.8, "cluster": 2, "source": "img001.jpg" },
  { "x": 0.30, "y":  0.1, "z": -0.2, "cluster": 0, "data_type": "text", "text": "..." }
]
```

Image points reference files under `tomorrow/`. Text points carry their
content in a `text` field.

## Running locally

Static site — open `index.html` in a browser, or serve with any static server.
The geo viewer requires HTTPS for GPS and the tilt sensor:

```bash
# generate a self-signed cert (once)
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 \
  -subj "/CN=localhost"

# serve over HTTPS on the LAN so the phone can reach it
npx http-server -S -C cert.pem -K key.pem -p 8443
```

Then visit `https://<your-mac-ip>:8443/geo.html` on your phone and accept the
self-signed cert warning.

## Deployment

Any static host works. For GitHub Pages: push the repo and enable Pages from
the repository settings (`main` branch, root).
