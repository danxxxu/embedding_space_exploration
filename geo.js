/* ═══════════════════════════════════════════════════════════════
   geo.js — Embedding space mapped onto physical geography
   Uses Leaflet + Geolocation API. No server required.
   ═══════════════════════════════════════════════════════════════ */

/* ── state ── */
let points = [];
let bounds = {
  minX: Infinity, maxX: -Infinity,
  minY: Infinity, maxY: -Infinity,
  minZ: Infinity, maxZ: -Infinity,
};

let params = {
  centerLat: 52.3676,   // Amsterdam default
  centerLng: 4.9041,
  radiusMeters: 200,
  plane: "XY",          // which 2D slice maps to lat/lng
  depthRange: 1.0,
  depthCenter: 0.0,
  cursorRange: 0.50,    // in embedding units
};

let gpsActive = false;
let watchId = null;
let gpsAccuracy = null;
let gpsPermissionGranted = false;  // true once we've successfully acquired GPS at least once

/* ── tilt sensor state ── */
let tiltActive = false;
let tiltBaselineBeta = null;  // beta value when tilt was enabled (calibration)
let tiltSmoothed = 0;         // smoothed delta beta in degrees
const TILT_SMOOTHING = 0.15;  // EMA factor (0..1, higher = more responsive)
const TILT_MAX_DEG = 90;      // ±90° = full depth range

/* ── haptics / audio feedback state ── */
let wasInImageArea = false;   // for edge-triggered strong vibration
let audioCtx = null;          // lazy Web Audio context (iOS fallback)
let soundEnabled = true;      // master mute for audio feedback

/* cursor position in embedding space */
let cursor = { h: 0, v: 0, depth: 0 };
let cursorSet = false;  // true once GPS or tap has placed cursor

/* Leaflet objects */
let map = null;
let tileLayer = null;
let areaCircle = null;
let userMarker = null;
let userAccuracyCircle = null;
let markerLayer = null;
let pointMarkers = [];     // parallel to `points`

/* preview state */
let lastPreviewImgSrc = "";
let lastPreviewText = "";

/* ── constants ── */
const METERS_PER_DEG_LAT = 111320;
const CLUSTER_COLORS = [
  "#ff6384", "#36a2eb", "#ffce56", "#4bc0c0", "#9966ff"
];

/* ═══════════════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════════════ */
document.addEventListener("DOMContentLoaded", () => {
  initMap();
  initControls();
  loadDefaultData();
});

/* ── map ── */
function initMap() {
  map = L.map("map", {
    center: [params.centerLat, params.centerLng],
    zoom: 16,
    zoomControl: true,
  });

  tileLayer = L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; OSM &amp; CARTO',
      maxZoom: 20,
    }
  ).addTo(map);

  markerLayer = L.layerGroup().addTo(map);

  // draw the mapping area circle
  areaCircle = L.circle([params.centerLat, params.centerLng], {
    radius: params.radiusMeters,
    color: "#7aa2f7",
    weight: 1.5,
    fillColor: "#7aa2f7",
    fillOpacity: 0.06,
    dashArray: "6 4",
  }).addTo(map);

  // tap map to set center
  map.on("click", (e) => {
    // only move center if shift-click (avoid accidental taps on mobile)
    // on mobile use the "Set center here" button with GPS position instead
  });
}

/* ── load data ── */
function loadDefaultData() {
  fetch("tomorrow.json")
    .then(r => r.json())
    .then(data => {
      points = Array.isArray(data) ? data : Object.values(data);
      computeBounds();
      plotMarkers();
      document.getElementById("data-status").textContent = `${points.length} pts`;
      document.getElementById("data-status").classList.add("ok");
    })
    .catch(() => {
      document.getElementById("data-status").textContent = "load failed";
      document.getElementById("data-status").classList.add("err");
    });
}

function computeBounds() {
  bounds = {
    minX: Infinity, maxX: -Infinity,
    minY: Infinity, maxY: -Infinity,
    minZ: Infinity, maxZ: -Infinity,
  };
  for (let p of points) {
    bounds.minX = Math.min(bounds.minX, p.x);
    bounds.maxX = Math.max(bounds.maxX, p.x);
    bounds.minY = Math.min(bounds.minY, p.y);
    bounds.maxY = Math.max(bounds.maxY, p.y);
    bounds.minZ = Math.min(bounds.minZ, p.z);
    bounds.maxZ = Math.max(bounds.maxZ, p.z);
  }
}

/* ═══════════════════════════════════════════════════════════════
   COORDINATE MAPPING
   ═══════════════════════════════════════════════════════════════ */

/* get axis config for current plane selection */
function getAxes() {
  // returns { h: "x"|"y"|"z", v: "x"|"y"|"z", depth: "x"|"y"|"z" }
  switch (params.plane) {
    case "XY": return { h: "x", v: "y", depth: "z" };
    case "XZ": return { h: "x", v: "z", depth: "y" };
    case "YZ": return { h: "y", v: "z", depth: "x" };
    default:   return { h: "x", v: "y", depth: "z" };
  }
}

function getEmbeddingBounds(axis) {
  switch (axis) {
    case "x": return [bounds.minX, bounds.maxX];
    case "y": return [bounds.minY, bounds.maxY];
    case "z": return [bounds.minZ, bounds.maxZ];
  }
}

function getGeoBounds() {
  let mPerDegLng = METERS_PER_DEG_LAT * Math.cos(params.centerLat * Math.PI / 180);
  let dLat = params.radiusMeters / METERS_PER_DEG_LAT;
  let dLng = params.radiusMeters / mPerDegLng;
  return {
    minLat: params.centerLat - dLat,
    maxLat: params.centerLat + dLat,
    minLng: params.centerLng - dLng,
    maxLng: params.centerLng + dLng,
  };
}

/* embedding point -> geo lat/lng */
function embeddingToGeo(point) {
  let axes = getAxes();
  let [embMinH, embMaxH] = getEmbeddingBounds(axes.h);
  let [embMinV, embMaxV] = getEmbeddingBounds(axes.v);
  let geo = getGeoBounds();

  let tH = (embMaxH - embMinH) !== 0 ? (point[axes.h] - embMinH) / (embMaxH - embMinH) : 0.5;
  let tV = (embMaxV - embMinV) !== 0 ? (point[axes.v] - embMinV) / (embMaxV - embMinV) : 0.5;

  let lat = geo.minLat + tV * (geo.maxLat - geo.minLat);
  let lng = geo.minLng + tH * (geo.maxLng - geo.minLng);

  return [lat, lng];
}

/* geo lat/lng -> embedding coords (2 mapped axes) */
function geoToEmbedding(lat, lng) {
  let axes = getAxes();
  let [embMinH, embMaxH] = getEmbeddingBounds(axes.h);
  let [embMinV, embMaxV] = getEmbeddingBounds(axes.v);
  let geo = getGeoBounds();

  let tH = (geo.maxLng - geo.minLng) !== 0 ? (lng - geo.minLng) / (geo.maxLng - geo.minLng) : 0.5;
  let tV = (geo.maxLat - geo.minLat) !== 0 ? (lat - geo.minLat) / (geo.maxLat - geo.minLat) : 0.5;

  let embH = embMinH + tH * (embMaxH - embMinH);
  let embV = embMinV + tV * (embMaxV - embMinV);

  return { h: embH, v: embV, axisH: axes.h, axisV: axes.v, axisDepth: axes.depth };
}

/* depth value of a point on the unmapped axis */
function getDepth(point) {
  let axes = getAxes();
  return point[axes.depth];
}

/* full 3D distance in embedding space between cursor and a point */
function embeddingDist(point) {
  let axes = getAxes();
  let dH = cursor.h - point[axes.h];
  let dV = cursor.v - point[axes.v];
  let dD = params.depthCenter - getDepth(point);
  return Math.sqrt(dH * dH + dV * dV + dD * dD);
}

/* is a point within the depth slab? */
function inDepthRange(point) {
  return Math.abs(getDepth(point) - params.depthCenter) <= params.depthRange;
}

/* ═══════════════════════════════════════════════════════════════
   MARKER PLOTTING
   ═══════════════════════════════════════════════════════════════ */
function plotMarkers() {
  markerLayer.clearLayers();
  pointMarkers = [];

  for (let i = 0; i < points.length; i++) {
    let p = points[i];
    let [lat, lng] = embeddingToGeo(p);
    let visible = inDepthRange(p);
    let col = CLUSTER_COLORS[p.cluster % CLUSTER_COLORS.length];

    let marker = L.circleMarker([lat, lng], {
      radius: 4,
      color: col,
      fillColor: col,
      fillOpacity: visible ? 0.7 : 0.1,
      weight: visible ? 1 : 0,
      opacity: visible ? 0.9 : 0.15,
    });

    marker._ptIndex = i;

    // tap marker: move cursor to this point so tilt/GPS can scroll from here
    marker.on("click", (e) => {
      L.DomEvent.stopPropagation(e);
      let pt = points[i];
      let axes = getAxes();
      cursor.h = pt[axes.h];
      cursor.v = pt[axes.v];
      cursorSet = true;

      // also drop a user marker at the tapped marker's location for visual feedback
      let latlng = pointMarkers[i].getLatLng();
      if (!userMarker) {
        userMarker = L.circleMarker(latlng, {
          radius: 8, color: "#fff", fillColor: "#7aa2f7",
          fillOpacity: 0.9, weight: 2,
        }).addTo(map);
      } else {
        userMarker.setLatLng(latlng);
      }

      highlightNearby();
    });

    markerLayer.addLayer(marker);
    pointMarkers.push(marker);
  }
}

/* reposition all markers (after center/radius/plane change) */
function updateMarkerPositions() {
  for (let i = 0; i < points.length; i++) {
    let [lat, lng] = embeddingToGeo(points[i]);
    pointMarkers[i].setLatLng([lat, lng]);
  }
}

/* update just visibility/opacity (after depth change) */
function updateMarkerVisibility() {
  for (let i = 0; i < points.length; i++) {
    let visible = inDepthRange(points[i]);
    let col = CLUSTER_COLORS[points[i].cluster % CLUSTER_COLORS.length];
    pointMarkers[i].setStyle({
      fillOpacity: visible ? 0.7 : 0.1,
      weight: visible ? 1 : 0,
      opacity: visible ? 0.9 : 0.15,
    });
  }
}

/* highlight points near cursor */
function highlightNearby() {
  let closestImage = null, closestImageDist = Infinity;
  let closestText = null, closestTextDist = Infinity;
  let globalNearest = Infinity;

  for (let i = 0; i < points.length; i++) {
    let p = points[i];
    if (!inDepthRange(p)) {
      pointMarkers[i].setRadius(4);
      pointMarkers[i].setStyle({ weight: 0 });
      continue;
    }

    let d = embeddingDist(p);
    if (d < globalNearest) globalNearest = d;

    let inRange = d < params.cursorRange;
    pointMarkers[i].setRadius(inRange ? 8 : 4);
    pointMarkers[i].setStyle({ weight: inRange ? 2 : 1 });

    let isImage = (p.data_type === "image" || !p.data_type);
    let isText = (p.data_type === "text");

    if (isImage && d < closestImageDist) {
      closestImageDist = d;
      closestImage = p;
    }
    if (isText && d < closestTextDist) {
      closestTextDist = d;
      closestText = p;
    }
  }

  // status readout: always show nearest distance so user can tune range
  let nearestEl = document.getElementById("nearest-status");
  if (globalNearest < Infinity) {
    let withinRange = globalNearest < params.cursorRange;
    nearestEl.textContent = `nearest: ${globalNearest.toFixed(2)}`;
    nearestEl.className = "status " + (withinRange ? "ok" : "warn");
  } else {
    nearestEl.textContent = "--";
    nearestEl.className = "status";
  }

  showPreview(closestImage, closestImageDist, closestText, closestTextDist);
}

function showPreview(closestImage, closestImageDist, closestText, closestTextDist) {
  let overlay = document.getElementById("preview-overlay");
  let hasContent = false;

  // image
  if (closestImage && closestImageDist < params.cursorRange) {
    let src = "tomorrow/" + closestImage.source;
    if (src !== lastPreviewImgSrc) {
      document.getElementById("preview-img").src = src;
      lastPreviewImgSrc = src;
      // light feedback on each new image shown
      hapticLight();
    }
    document.getElementById("preview-img").style.display = "block";
    document.getElementById("img-empty").style.display = "none";
    document.getElementById("img-meta").textContent =
      `cluster ${closestImage.cluster} | d=${closestImageDist.toFixed(3)}`;
    hasContent = true;
  } else {
    document.getElementById("preview-img").style.display = "none";
    document.getElementById("img-empty").style.display = "block";
    document.getElementById("img-meta").textContent = "";
    lastPreviewImgSrc = "";
  }

  // text
  if (closestText && closestTextDist < params.cursorRange) {
    document.getElementById("preview-text").textContent = closestText.text;
    document.getElementById("preview-text").style.display = "block";
    document.getElementById("txt-empty").style.display = "none";
    document.getElementById("txt-meta").textContent =
      `cluster ${closestText.cluster} | d=${closestTextDist.toFixed(3)}`;
    hasContent = true;
  } else {
    document.getElementById("preview-text").style.display = "none";
    document.getElementById("txt-empty").style.display = "block";
    document.getElementById("txt-meta").textContent = "";
  }

  overlay.classList.toggle("visible", hasContent);
}

/* ═══════════════════════════════════════════════════════════════
   GPS / GEOLOCATION
   ═══════════════════════════════════════════════════════════════ */
function startGPS() {
  if (!navigator.geolocation) {
    setGPSStatus("no geolocation", "err");
    return;
  }

  setGPSStatus("requesting...", "warn");

  // Flip UI to "Stop GPS" immediately so the user can always stop the session
  // even if the first fix is slow to arrive.
  gpsActive = true;
  document.getElementById("btn-gps").textContent = "Stop GPS";
  document.getElementById("btn-gps").classList.add("active");

  if (!gpsPermissionGranted) {
    // First time this page load: iOS needs a one-shot getCurrentPosition
    // from a user gesture to prompt for permission before watchPosition
    // will work reliably.
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        gpsPermissionGranted = true;
        onGPSPosition(pos);
        beginWatch();
      },
      onGPSError,
      { enableHighAccuracy: true, timeout: 15000 }
    );
  } else {
    // Permission already granted — skip the bootstrap call (which tends to
    // timeout on cold-restart because iOS releases the GPS chip on stopGPS).
    // Start watching directly; the first fix arrives when iOS warms up.
    beginWatch();
  }
}

function beginWatch() {
  // watchPosition: NO timeout. iOS throttles updates when the phone is
  // stationary, and a timeout error would spuriously tear down the watch.
  // maximumAge: 2000 lets a very-recent cached position satisfy the first
  // callback so we don't sit at "requesting..." while waiting for a cold fix.
  watchId = navigator.geolocation.watchPosition(
    onGPSPosition,
    onGPSWatchError,
    { enableHighAccuracy: true, maximumAge: 2000 }
  );
}

function stopGPS() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  gpsActive = false;
  wasInImageArea = false;
  setGPSStatus("GPS off", "");
  document.getElementById("btn-gps").textContent = "Start GPS";
  document.getElementById("btn-gps").classList.remove("active");

  if (userMarker) { map.removeLayer(userMarker); userMarker = null; }
  if (userAccuracyCircle) { map.removeLayer(userAccuracyCircle); userAccuracyCircle = null; }
}

function onGPSPosition(pos) {
  let lat = pos.coords.latitude;
  let lng = pos.coords.longitude;
  gpsAccuracy = pos.coords.accuracy;

  setGPSStatus(`${gpsAccuracy.toFixed(0)}m`, gpsAccuracy < 15 ? "ok" : "warn");

  // update user position on map
  if (!userMarker) {
    userMarker = L.circleMarker([lat, lng], {
      radius: 8,
      color: "#fff",
      fillColor: "#7aa2f7",
      fillOpacity: 0.9,
      weight: 2,
    }).addTo(map);

    userAccuracyCircle = L.circle([lat, lng], {
      radius: gpsAccuracy,
      color: "#7aa2f7",
      fillColor: "#7aa2f7",
      fillOpacity: 0.08,
      weight: 1,
      dashArray: "4 4",
    }).addTo(map);
  } else {
    userMarker.setLatLng([lat, lng]);
    userAccuracyCircle.setLatLng([lat, lng]);
    userAccuracyCircle.setRadius(gpsAccuracy);
  }

  // convert GPS to embedding space
  let emb = geoToEmbedding(lat, lng);
  cursor.h = emb.h;
  cursor.v = emb.v;
  cursorSet = true;

  // strong vibration on entering an area with images (ignores depth)
  checkImageAreaVibration();

  highlightNearby();
}

/* ── haptic + audio feedback ── */

/* lazy-init Web Audio context. must be called from a user gesture
   (tap Start GPS / Start Tilt) or iOS will leave it suspended. */
function ensureAudio() {
  if (!audioCtx) {
    let AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume();
  }
  return audioCtx;
}

/* play a short sine tone with attack/release envelope to avoid clicks */
function playBeep(freq, duration, gainValue) {
  if (!soundEnabled) return;
  let ctx = audioCtx;
  if (!ctx || ctx.state !== "running") return;

  let osc = ctx.createOscillator();
  let g = ctx.createGain();

  osc.type = "sine";
  osc.frequency.value = freq;

  let now = ctx.currentTime;
  let attack = 0.005;
  let release = Math.max(0.01, duration - attack);

  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(gainValue, now + attack);
  g.gain.linearRampToValueAtTime(0, now + attack + release);

  osc.connect(g);
  g.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + attack + release + 0.02);
}

/* strong feedback: vibration + two-tone chord */
function hapticStrong() {
  if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
  playBeep(220, 0.14, 0.18);
  playBeep(330, 0.10, 0.12);
}

/* light feedback: short vibration + brief high tick */
function hapticLight() {
  if (navigator.vibrate) navigator.vibrate(25);
  playBeep(880, 0.04, 0.08);
}

/* checks if any image point exists within cursor range on the mapped 2D plane
   (ignoring the depth axis), and fires on the "entering" edge */
function checkImageAreaVibration() {
  let axes = getAxes();
  let range = params.cursorRange;
  let range2 = range * range;
  let inArea = false;

  for (let i = 0; i < points.length; i++) {
    let p = points[i];
    let isImage = (p.data_type === "image" || !p.data_type);
    if (!isImage) continue;

    let dH = cursor.h - p[axes.h];
    let dV = cursor.v - p[axes.v];
    if (dH * dH + dV * dV < range2) {
      inArea = true;
      break;
    }
  }

  if (inArea && !wasInImageArea) {
    hapticStrong();
  }
  wasInImageArea = inArea;
}

/* error handler for the initial getCurrentPosition (startup).
   Any error here means we never acquired GPS, so reset the UI. */
function onGPSError(err) {
  // err.code: 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT
  let msg;
  switch (err.code) {
    case 1:
      msg = "denied — open Settings > Safari > Location";
      break;
    case 2:
      msg = "position unavailable";
      break;
    case 3:
      msg = "GPS timeout";
      break;
    default:
      msg = err.message || "unknown error";
  }
  setGPSStatus(msg, "err");
  console.warn("GPS error:", err.code, err.message);

  // reset state so user can retry
  gpsActive = false;
  document.getElementById("btn-gps").textContent = "Start GPS";
  document.getElementById("btn-gps").classList.remove("active");
}

/* error handler for ongoing watchPosition events.
   iOS fires transient POSITION_UNAVAILABLE / TIMEOUT errors between fixes;
   we must NOT stop the watch or reset the UI for those — we just show a
   warning and keep waiting. Only a permission denial actually kills it. */
function onGPSWatchError(err) {
  console.warn("GPS watch error:", err.code, err.message);

  if (err.code === 1) {
    // permission actually revoked — stop the watch
    stopGPS();
    setGPSStatus("denied — open Settings > Safari > Location", "err");
    return;
  }

  // transient error: keep the watch alive, just reflect it in the status
  let msg = err.code === 3 ? "waiting for fix..." : "signal lost...";
  setGPSStatus(msg, "warn");
}

function setGPSStatus(text, cls) {
  let el = document.getElementById("gps-status");
  el.textContent = text;
  el.className = "status";
  if (cls) el.classList.add(cls);
}

/* ═══════════════════════════════════════════════════════════════
   TILT SENSOR (DeviceOrientation)
   ═══════════════════════════════════════════════════════════════ */
function startTilt() {
  // iOS 13+ requires explicit permission from a user gesture
  if (typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function") {
    DeviceOrientationEvent.requestPermission()
      .then((state) => {
        if (state === "granted") {
          attachTiltListener();
        } else {
          setTiltStatus("permission denied", "err");
        }
      })
      .catch((err) => {
        setTiltStatus("error: " + err.message, "err");
      });
  } else if ("DeviceOrientationEvent" in window) {
    // Android / older iOS — no permission needed
    attachTiltListener();
  } else {
    setTiltStatus("not supported", "err");
  }
}

function attachTiltListener() {
  tiltActive = true;
  tiltBaselineBeta = null;  // will be set on first event
  tiltSmoothed = 0;
  window.addEventListener("deviceorientation", onTiltEvent);
  document.getElementById("btn-tilt").textContent = "Stop Tilt";
  document.getElementById("btn-tilt").classList.add("active");
  setTiltStatus("calibrating...", "warn");
}

function stopTilt() {
  tiltActive = false;
  window.removeEventListener("deviceorientation", onTiltEvent);
  document.getElementById("btn-tilt").textContent = "Start Tilt";
  document.getElementById("btn-tilt").classList.remove("active");
  setTiltStatus("tilt off", "");

  // re-enable the depth-center slider
  document.getElementById("depth-center").disabled = false;
}

function onTiltEvent(e) {
  if (e.beta === null || e.beta === undefined) return;

  // capture baseline on first event so the current hold position = neutral
  if (tiltBaselineBeta === null) {
    tiltBaselineBeta = e.beta;
  }

  // delta: how far we've tilted from the initial hold position
  // positive delta = top edge raised (looking up)
  // negative delta = top edge lowered (looking down)
  let rawDelta = e.beta - tiltBaselineBeta;

  // clamp to [-90, 90]
  rawDelta = Math.max(-TILT_MAX_DEG, Math.min(TILT_MAX_DEG, rawDelta));

  // exponential moving average to smooth noisy sensor data
  tiltSmoothed = tiltSmoothed + TILT_SMOOTHING * (rawDelta - tiltSmoothed);

  // normalize delta to [-1, 1]
  let norm = tiltSmoothed / TILT_MAX_DEG;

  // map to depth range on the unmapped axis
  let axes = getAxes();
  let [depthMin, depthMax] = getEmbeddingBounds(axes.depth);
  let depthMid = (depthMin + depthMax) / 2;
  let depthHalf = (depthMax - depthMin) / 2;

  // norm = -1 → depthMin (tilt down), norm = +1 → depthMax (tilt up)
  params.depthCenter = depthMid + norm * depthHalf;

  // update UI (slider + label)
  let slider = document.getElementById("depth-center");
  let label = document.getElementById("depth-center-val");
  slider.value = params.depthCenter.toFixed(2);
  slider.disabled = true; // visually indicate sensor control
  label.textContent = params.depthCenter.toFixed(2);

  // show tilt angle in status
  setTiltStatus(`${rawDelta > 0 ? "+" : ""}${rawDelta.toFixed(0)}°`,
                Math.abs(rawDelta) > 5 ? "ok" : "warn");

  // update markers and preview
  updateMarkerVisibility();
  if (cursorSet) highlightNearby();
}

function setTiltStatus(text, cls) {
  let el = document.getElementById("tilt-status");
  el.textContent = text;
  el.className = "status";
  if (cls) el.classList.add(cls);
}

/* ═══════════════════════════════════════════════════════════════
   CONTROLS
   ═══════════════════════════════════════════════════════════════ */
function initControls() {
  // drawer toggle
  let drawer = document.getElementById("drawer");
  document.getElementById("drawer-handle").addEventListener("click", () => {
    drawer.classList.toggle("collapsed");
  });
  document.getElementById("btn-drawer-toggle").addEventListener("click", () => {
    drawer.classList.toggle("collapsed");
  });

  // GPS toggle
  document.getElementById("btn-gps").addEventListener("click", () => {
    ensureAudio();  // unlock audio context on user gesture (iOS requirement)
    gpsActive ? stopGPS() : startGPS();
  });

  // Tilt toggle
  document.getElementById("btn-tilt").addEventListener("click", () => {
    ensureAudio();  // unlock audio context on user gesture (iOS requirement)
    tiltActive ? stopTilt() : startTilt();
  });

  // Sound toggle
  document.getElementById("btn-sound").addEventListener("click", () => {
    soundEnabled = !soundEnabled;
    let btn = document.getElementById("btn-sound");
    btn.textContent = "Sound: " + (soundEnabled ? "on" : "off");
    btn.classList.toggle("active", soundEnabled);
    if (soundEnabled) {
      ensureAudio();
      // play a quick test beep so user confirms audio is working
      playBeep(660, 0.08, 0.1);
    }
  });

  // set center to current GPS position
  document.getElementById("btn-center").addEventListener("click", () => {
    if (userMarker) {
      let ll = userMarker.getLatLng();
      params.centerLat = ll.lat;
      params.centerLng = ll.lng;
      document.getElementById("center-lat").value = ll.lat.toFixed(6);
      document.getElementById("center-lng").value = ll.lng.toFixed(6);
      document.getElementById("center-lat-val").textContent = ll.lat.toFixed(4);
      document.getElementById("center-lng-val").textContent = ll.lng.toFixed(4);
      onMappingChanged();
    }
  });

  // center lat/lng inputs
  document.getElementById("center-lat").addEventListener("change", (e) => {
    params.centerLat = parseFloat(e.target.value);
    document.getElementById("center-lat-val").textContent = params.centerLat.toFixed(4);
    onMappingChanged();
  });
  document.getElementById("center-lng").addEventListener("change", (e) => {
    params.centerLng = parseFloat(e.target.value);
    document.getElementById("center-lng-val").textContent = params.centerLng.toFixed(4);
    onMappingChanged();
  });

  // radius slider
  bindSlider("radius", "radius-val", (v) => {
    params.radiusMeters = v;
    onMappingChanged();
  });

  // plane selector
  document.getElementById("plane-select").addEventListener("change", (e) => {
    params.plane = e.target.value;
    onMappingChanged();
  });

  // depth controls
  bindSlider("depth-range", "depth-range-val", (v) => {
    params.depthRange = v;
    updateMarkerVisibility();
    if (cursorSet) highlightNearby();
  });
  bindSlider("depth-center", "depth-center-val", (v) => {
    params.depthCenter = v;
    updateMarkerVisibility();
    if (cursorSet) highlightNearby();
  });

  // cursor range
  bindSlider("cursor-range", "cursor-range-val", (v) => {
    params.cursorRange = v;
    if (cursorSet) highlightNearby();
  });

  // file loader
  document.getElementById("load-json").addEventListener("change", (e) => {
    let file = e.target.files[0];
    if (!file) return;
    let reader = new FileReader();
    reader.onload = (ev) => {
      let data = JSON.parse(ev.target.result);
      points = Array.isArray(data) ? data : Object.values(data);
      computeBounds();
      plotMarkers();
      document.getElementById("data-status").textContent = `${points.length} pts`;
      document.getElementById("data-status").classList.add("ok");
    };
    reader.readAsText(file);
  });

  // allow click on map to act as manual cursor (for desktop testing)
  map.on("click", (e) => {
    if (gpsActive) return; // GPS takes priority
    let emb = geoToEmbedding(e.latlng.lat, e.latlng.lng);
    cursor.h = emb.h;
    cursor.v = emb.v;
    cursorSet = true;

    // show a temporary marker
    if (!userMarker) {
      userMarker = L.circleMarker(e.latlng, {
        radius: 8,
        color: "#fff",
        fillColor: "#7aa2f7",
        fillOpacity: 0.9,
        weight: 2,
      }).addTo(map);
    } else {
      userMarker.setLatLng(e.latlng);
    }

    highlightNearby();
  });
}

function bindSlider(sliderId, labelId, setter) {
  let slider = document.getElementById(sliderId);
  let label = document.getElementById(labelId);
  slider.addEventListener("input", () => {
    let v = parseFloat(slider.value);
    label.textContent = Number.isInteger(v) ? v : v.toFixed(2);
    setter(v);
  });
}

/* called when center, radius, or plane changes — need to rebuild geo mapping */
function onMappingChanged() {
  // update circle overlay
  areaCircle.setLatLng([params.centerLat, params.centerLng]);
  areaCircle.setRadius(params.radiusMeters);

  // recenter map
  map.setView([params.centerLat, params.centerLng]);

  // recompute all marker positions
  if (pointMarkers.length > 0) {
    updateMarkerPositions();
  }

  // re-run proximity if cursor has been set
  if (cursorSet) {
    highlightNearby();
  }
}
