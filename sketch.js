/* ── state ── */
let imagePoints = [];
let textPoints = [];
let cachedPoints = [];       // flat combined array, rebuilt only on data load
let clusterBuckets = [];     // [{color:[r,g,b], image:[p,...], text:[p,...]}] for batched drawing

let midiX = 0, midiY = 0, midiZ = 0;
let cursor = { x: 0, y: 0, z: 0 };

// input mode: "midi" or "keyboard"
let inputMode = "keyboard";

// keyboard cursor state (normalized 0–1, start at center)
let keyX = 0.5, keyY = 0.5, keyZ = 0.5;
let keyStep = 0.008;   // movement per frame when key is held

// MIDI CC mapping (nanoKONTROL2)
const CC_X = 16;
const CC_Y = 17;
const CC_Z = 18;

let bounds = {
  minX: Infinity, maxX: -Infinity,
  minY: Infinity, maxY: -Infinity,
  minZ: Infinity, maxZ: -Infinity,
};

/* ── control panel params ── */
let params = {
  cursorRange: 0.15,
  cursorSize: 0.08,
  pointSize: 0.02,
  highlightSize: 0.035,
  blendMode: "off",    // "off" | "opacity" | "pixel"
  blendOffsetStrength: 1.0,
  blendMaxAlpha: 1.0,
  blendMinAlpha: 0.05,
};

/* ── preview canvases (p5 instance mode) ── */
let imgSketch = null;
let loadedImg = null;
let lastImageSrc = "";

/* ── blend mode state ── */
let imageCache = {};        // src -> p5.Image
let blendQueue = [];        // [{img, alpha, offsetX, offsetY}, ...] set each frame
let blendQueueDirty = false;
let pixelBlendBuffer = null;   // off-screen graphics for pixel blend compositing

/* ── main p5 sketch ── */
function preload() {
  imagePoints = loadJSON("tomorrow.json");
}

function setup() {
  rebuildPointCache();
  computeBounds();

  let container = document.getElementById("canvas-3d");
  let w = container.clientWidth;
  let h = container.clientHeight;
  let cnv = createCanvas(w, h, WEBGL);
  cnv.parent("canvas-3d");

  initMIDI();
  initControls();
  initImageCanvas();
  initFileLoaders();
}

function windowResized() {
  let container = document.getElementById("canvas-3d");
  resizeCanvas(container.clientWidth, container.clientHeight);
}

function computeBounds() {
  bounds = {
    minX: Infinity, maxX: -Infinity,
    minY: Infinity, maxY: -Infinity,
    minZ: Infinity, maxZ: -Infinity,
  };
  for (let i = 0; i < cachedPoints.length; i++) {
    let p = cachedPoints[i];
    if (p.x < bounds.minX) bounds.minX = p.x;
    if (p.x > bounds.maxX) bounds.maxX = p.x;
    if (p.y < bounds.minY) bounds.minY = p.y;
    if (p.y > bounds.maxY) bounds.maxY = p.y;
    if (p.z < bounds.minZ) bounds.minZ = p.z;
    if (p.z > bounds.maxZ) bounds.maxZ = p.z;
  }
}

/* rebuild the flat combined point array + per-cluster buckets.
   called once on data load, not every frame. */
function rebuildPointCache() {
  let img = Array.isArray(imagePoints) ? imagePoints : Object.values(imagePoints);
  let txt = Array.isArray(textPoints) ? textPoints : Object.values(textPoints);

  cachedPoints = new Array(img.length + txt.length);
  let idx = 0;
  for (let i = 0; i < img.length; i++) {
    let p = img[i];
    p._isText = false;
    cachedPoints[idx++] = p;
  }
  for (let i = 0; i < txt.length; i++) {
    let p = txt[i];
    p._isText = true;
    cachedPoints[idx++] = p;
  }

  // group by cluster for batched draw
  let map = new Map();
  for (let i = 0; i < cachedPoints.length; i++) {
    let p = cachedPoints[i];
    let key = (p._isText ? "t" : "i") + (p.cluster || 0);
    let bucket = map.get(key);
    if (!bucket) {
      let rgb = clusterRGB(p.cluster);
      bucket = { color: rgb, isText: p._isText, points: [] };
      map.set(key, bucket);
    }
    bucket.points.push(p);
  }
  clusterBuckets = Array.from(map.values());
}

function getAllPoints() {
  return cachedPoints;
}

/* ── MIDI ── */
function initMIDI() {
  if (navigator.requestMIDIAccess) {
    navigator.requestMIDIAccess().then(onMIDISuccess, onMIDIFailure);
  } else {
    console.warn("Web MIDI not supported");
  }
}

function onMIDISuccess(midiAccess) {
  let statusEl = document.getElementById("midi-status");
  for (let input of midiAccess.inputs.values()) {
    input.onmidimessage = onMIDIMessage;
    statusEl.textContent = input.name;
    statusEl.classList.add("connected");
  }
  midiAccess.onstatechange = (e) => {
    if (e.port.type === "input") {
      e.port.onmidimessage = onMIDIMessage;
      statusEl.textContent = e.port.name;
      statusEl.classList.add("connected");
    }
  };
}

function onMIDIFailure() {
  console.warn("Could not access MIDI devices");
}

function onMIDIMessage(msg) {
  let [status, cc, value] = msg.data;
  let n = value / 127.0;
  if (cc === CC_X) midiX = n;
  if (cc === CC_Y) midiY = n;
  if (cc === CC_Z) midiZ = n;

  // auto-switch to MIDI when a knob is moved
  if (inputMode !== "midi" && (cc === CC_X || cc === CC_Y || cc === CC_Z)) {
    inputMode = "midi";
    document.getElementById("input-mode").value = "midi";
  }
}

/* ── control panel bindings ── */
function initControls() {
  // input mode
  document.getElementById("input-mode").addEventListener("change", (e) => {
    inputMode = e.target.value;
  });
  bindSlider("key-speed", "key-speed-val", (v) => keyStep = v);

  bindSlider("cursor-range", "range-val", (v) => params.cursorRange = v);
  bindSlider("cursor-size", "cursor-size-val", (v) => params.cursorSize = v);
  bindSlider("point-size", "point-size-val", (v) => params.pointSize = v);
  bindSlider("highlight-size", "highlight-size-val", (v) => params.highlightSize = v);
  bindSlider("blend-offset", "blend-offset-val", (v) => params.blendOffsetStrength = v);
  bindSlider("blend-max-alpha", "blend-max-alpha-val", (v) => params.blendMaxAlpha = v);
  bindSlider("blend-min-alpha", "blend-min-alpha-val", (v) => params.blendMinAlpha = v);

  document.getElementById("blend-mode").addEventListener("change", (e) => {
    params.blendMode = e.target.value;
    // clear blend state when switching modes
    if (params.blendMode === "off") {
      blendQueue = [];
      blendQueueDirty = true;
      imgSketch.redraw();
    }
  });
}

function bindSlider(sliderId, labelId, setter) {
  let slider = document.getElementById(sliderId);
  let label = document.getElementById(labelId);
  slider.addEventListener("input", () => {
    let v = parseFloat(slider.value);
    label.textContent = v.toFixed(slider.step.includes(".00") ? 2 : 3);
    setter(v);
  });
}

/* ── file loaders for second dataset ── */
function initFileLoaders() {
  document.getElementById("load-image-json").addEventListener("change", (e) => {
    let file = e.target.files[0];
    if (!file) return;
    let reader = new FileReader();
    reader.onload = (ev) => {
      imagePoints = JSON.parse(ev.target.result);
      document.getElementById("img-dot").classList.add("active");
      rebuildPointCache();
      computeBounds();
    };
    reader.readAsText(file);
  });

  document.getElementById("load-text-json").addEventListener("change", (e) => {
    let file = e.target.files[0];
    if (!file) return;
    let reader = new FileReader();
    reader.onload = (ev) => {
      textPoints = JSON.parse(ev.target.result);
      document.getElementById("txt-dot").classList.add("active");
      rebuildPointCache();
      computeBounds();
    };
    reader.readAsText(file);
  });
}

/* ── image preview canvas (p5 instance mode) ── */
function initImageCanvas() {
  imgSketch = new p5((s) => {
    s.setup = () => {
      let holder = document.getElementById("image-canvas-holder");
      let cnv = s.createCanvas(holder.clientWidth - 24, holder.clientHeight - 24);
      cnv.parent("image-canvas-holder");
      s.noLoop();
    };

    s.windowResized = () => {
      let holder = document.getElementById("image-canvas-holder");
      s.resizeCanvas(holder.clientWidth - 24, holder.clientHeight - 24);
      s.redraw();
    };

    s.draw = () => {
      s.background(14);

      let isBlend = params.blendMode !== "off";

      // ── blend modes (opacity or pixel) ──
      if (isBlend) {
        if (blendQueue.length === 0) {
          s.fill(50); s.noStroke();
          s.textAlign(s.CENTER, s.CENTER); s.textSize(12);
          s.text("No images in range", s.width / 2, s.height / 2);
          return;
        }

        if (params.blendMode === "opacity") {
          // draw farthest first (lowest alpha), closest last (highest alpha)
          for (let entry of blendQueue) {
            let img = entry.img;
            if (!img || img.width === 0) continue;

            let aspect = img.width / img.height;
            let drawW, drawH;
            if (aspect > s.width / s.height) {
              drawW = s.width;
              drawH = s.width / aspect;
            } else {
              drawH = s.height;
              drawW = s.height * aspect;
            }

            let cx = (s.width - drawW) / 2;
            let cy = (s.height - drawH) / 2;

            let shiftX = -entry.offsetX * params.blendOffsetStrength * drawW;
            let shiftY = -entry.offsetY * params.blendOffsetStrength * drawH;

            s.tint(255, entry.alpha);
            s.image(img, cx + shiftX, cy + shiftY, drawW, drawH);
          }
          s.noTint();

        } else if (params.blendMode === "pixel") {
          // ── pixel-value weighted average ──
          drawPixelBlend(s);
        }
        return;
      }

      // ── single image mode ──
      if (!loadedImg) {
        s.fill(50); s.noStroke();
        s.textAlign(s.CENTER, s.CENTER); s.textSize(12);
        s.text("No image in range", s.width / 2, s.height / 2);
        return;
      }

      let aspect = loadedImg.width / loadedImg.height;
      let drawW, drawH;
      if (aspect > s.width / s.height) {
        drawW = s.width;
        drawH = s.width / aspect;
      } else {
        drawH = s.height;
        drawW = s.height * aspect;
      }
      let x = (s.width - drawW) / 2;
      let y = (s.height - drawH) / 2;
      s.image(loadedImg, x, y, drawW, drawH);
    };
  });
}

/* ── pixel blend: GPU-accelerated weighted average via incremental alpha ──
   Instead of reading pixels in JS, we use a compositing trick:
     draw image 1 at alpha = 1.0
     draw image 2 at alpha = w2 / (w1 + w2)
     draw image 3 at alpha = w3 / (w1 + w2 + w3)
     ...
   This produces a mathematically exact weighted average using only the
   canvas alpha compositor — no loadPixels, no per-pixel loops. */
function drawPixelBlend(s) {
  // create / resize the off-screen 2D buffer as needed
  if (!pixelBlendBuffer || pixelBlendBuffer.width !== s.width || pixelBlendBuffer.height !== s.height) {
    if (pixelBlendBuffer) pixelBlendBuffer.remove();
    pixelBlendBuffer = s.createGraphics(s.width, s.height);
  }

  // collect loaded images and their raw weights
  let entries = [];
  for (let entry of blendQueue) {
    if (!entry.img || entry.img.width === 0) continue;
    let w = entry.alpha / 255; // closer = higher weight
    entries.push({ img: entry.img, weight: w, offsetX: entry.offsetX, offsetY: entry.offsetY });
  }
  if (entries.length === 0) return;

  // sort by weight ascending so lightest (farthest) is drawn first,
  // heaviest (closest) last — last image has greatest influence
  entries.sort((a, b) => a.weight - b.weight);

  let buf = pixelBlendBuffer;
  // access the underlying 2D canvas context for globalAlpha control
  let ctx = buf.drawingContext;

  buf.clear();

  let cumWeight = 0;
  for (let i = 0; i < entries.length; i++) {
    let e = entries[i];
    cumWeight += e.weight;

    // incremental alpha: this image's share of the running total
    let alpha = (i === 0) ? 1.0 : e.weight / cumWeight;

    let img = e.img;
    let aspect = img.width / img.height;
    let drawW, drawH;
    if (aspect > buf.width / buf.height) {
      drawW = buf.width;
      drawH = buf.width / aspect;
    } else {
      drawH = buf.height;
      drawW = buf.height * aspect;
    }

    let cx = (buf.width - drawW) / 2;
    let cy = (buf.height - drawH) / 2;

    // apply positional offset (same as opacity mode)
    let shiftX = -e.offsetX * params.blendOffsetStrength * drawW;
    let shiftY = -e.offsetY * params.blendOffsetStrength * drawH;

    ctx.globalAlpha = alpha;
    buf.image(img, cx + shiftX, cy + shiftY, drawW, drawH);
  }
  ctx.globalAlpha = 1.0;

  // draw the composited buffer to the main canvas
  s.image(buf, 0, 0, s.width, s.height);
}

/* ── image cache helper ── */
function getCachedImage(src) {
  if (imageCache[src]) return imageCache[src];
  let img = imgSketch.loadImage(src, () => {
    imgSketch.redraw();
  });
  imageCache[src] = img;
  return img;
}

function updateImagePreview(src) {
  if (src === lastImageSrc) return;
  lastImageSrc = src;

  let holder = document.getElementById("image-canvas-holder");
  let emptyState = holder.querySelector(".empty-state");
  if (emptyState) emptyState.remove();

  loadedImg = getCachedImage(src);
  imgSketch.redraw();
}

function clearImagePreview() {
  if (lastImageSrc === "") return;
  lastImageSrc = "";
  loadedImg = null;
  imgSketch.redraw();
}

/* ── blend mode: build the queue from in-range image points ── */
function updateBlendQueue(inRangeImages) {
  let holder = document.getElementById("image-canvas-holder");
  let emptyState = holder.querySelector(".empty-state");
  if (emptyState) emptyState.remove();

  document.getElementById("blend-count").textContent = inRangeImages.length;

  if (inRangeImages.length === 0) {
    blendQueue = [];
    imgSketch.redraw();
    return;
  }

  // sort farthest first so closest paints on top
  inRangeImages.sort((a, b) => b.dist - a.dist);

  let range = params.cursorRange;
  let minA = params.blendMinAlpha;

  blendQueue = inRangeImages.map((entry) => {
    // alpha: closer = more opaque
    // at distance 0 -> maxAlpha*255, at cursorRange -> minAlpha*255
    let maxA = params.blendMaxAlpha;
    let t = entry.dist / range; // 0 (closest) to 1 (edge)
    let alpha = Math.round((maxA - t * (maxA - minA)) * 255);

    // normalized offset in each axis, -1 to 1 range
    let offsetX = range > 0 ? (entry.p.x - cursor.x) / range : 0;
    let offsetY = range > 0 ? (entry.p.y - cursor.y) / range : 0;

    let src = "tomorrow/" + entry.p.source;
    let img = getCachedImage(src);

    return { img, alpha, offsetX, offsetY };
  });

  imgSketch.redraw();
}

/* ── text preview ── */
function updateTextPreview(text, meta) {
  let container = document.getElementById("text-preview");
  let metaEl = document.getElementById("text-meta");

  let emptyState = container.querySelector(".empty-state");
  if (emptyState) emptyState.remove();

  let content = container.querySelector("#text-content");
  if (!content) {
    content = document.createElement("div");
    content.id = "text-content";
    container.appendChild(content);
  }
  content.textContent = text;
  metaEl.textContent = meta || "";
}

function clearTextPreview() {
  let container = document.getElementById("text-preview");
  let metaEl = document.getElementById("text-meta");
  container.innerHTML = '<div class="empty-state">No text in range</div>';
  metaEl.textContent = "";
}

/* ── main draw loop ── */
function draw() {
  background(10);
  orbitControl();
  scale(120);
  drawAxes(4);

  if (inputMode === "keyboard") {
    updateKeyboardCursor();
    cursor.x = map(keyX, 0, 1, bounds.minX, bounds.maxX);
    cursor.y = map(keyY, 0, 1, bounds.minY, bounds.maxY);
    cursor.z = map(keyZ, 0, 1, bounds.minZ, bounds.maxZ);
  } else {
    cursor.x = map(midiX, 0, 1, bounds.minX, bounds.maxX);
    cursor.y = map(midiY, 0, 1, bounds.minY, bounds.maxY);
    cursor.z = map(midiZ, 0, 1, bounds.minZ, bounds.maxZ);
  }

  // update position readout
  document.getElementById("pos-x").textContent = cursor.x.toFixed(2);
  document.getElementById("pos-y").textContent = cursor.y.toFixed(2);
  document.getElementById("pos-z").textContent = cursor.z.toFixed(2);

  drawBoxFaces();
  drawBoxGrids();
  drawPoints();
  drawCursor();
  drawCursorCrosshair();
}

/* ── keyboard cursor movement ── */
function updateKeyboardCursor() {
  // Left/Right → X (red axis)
  if (keyIsDown(LEFT_ARROW))  keyX = Math.max(0, keyX - keyStep);
  if (keyIsDown(RIGHT_ARROW)) keyX = Math.min(1, keyX + keyStep);
  // A/S → Y (green axis)
  if (keyIsDown(65))          keyY = Math.max(0, keyY - keyStep); // A
  if (keyIsDown(83))          keyY = Math.min(1, keyY + keyStep); // S
  // Up/Down → Z (blue axis)
  if (keyIsDown(UP_ARROW))    keyZ = Math.max(0, keyZ - keyStep);
  if (keyIsDown(DOWN_ARROW))  keyZ = Math.min(1, keyZ + keyStep);
}

/* prevent arrow keys from scrolling the page */
function keyPressed() {
  if (inputMode === "keyboard") {
    if (keyCode === LEFT_ARROW || keyCode === RIGHT_ARROW ||
        keyCode === UP_ARROW || keyCode === DOWN_ARROW) {
      return false; // suppress default browser behavior
    }
  }
}

/* ── drawing functions ── */
function drawCursor() {
  push();
  translate(cursor.x, cursor.y, cursor.z);
  noFill();
  stroke(255);
  strokeWeight(1.5);
  sphere(params.cursorSize);
  noStroke();
  fill(255);
  sphere(0.03);
  pop();
}

function drawPoints() {
  let pts = cachedPoints;
  let closestImage = null, closestImageDist = Infinity;
  let closestText = null, closestTextDist = Infinity;
  let inRangeImages = []; // for blend mode
  let highlightedSet = null; // only allocate if we find any

  let cx = cursor.x, cy = cursor.y, cz = cursor.z;
  let range = params.cursorRange;
  let rangeSq = range * range;

  // ── pass 1: distance scan + identify highlighted / closest ──
  for (let i = 0; i < pts.length; i++) {
    let p = pts[i];
    let dx = cx - p.x, dy = cy - p.y, dz = cz - p.z;
    let dSq = dx*dx + dy*dy + dz*dz;
    let isText = p._isText;

    if (isText) {
      if (dSq < closestTextDist) {
        closestTextDist = dSq;
        closestText = p;
      }
    } else {
      if (dSq < closestImageDist) {
        closestImageDist = dSq;
        closestImage = p;
      }
      if (dSq < rangeSq) {
        let d = Math.sqrt(dSq);
        inRangeImages.push({ p, dist: d });
        if (!highlightedSet) highlightedSet = new Set();
        highlightedSet.add(p);
      }
    }

    if (isText && dSq < rangeSq) {
      if (!highlightedSet) highlightedSet = new Set();
      highlightedSet.add(p);
    }
  }
  closestImageDist = Math.sqrt(closestImageDist);
  closestTextDist = Math.sqrt(closestTextDist);

  // ── pass 2: batched draw of non-highlighted points, grouped by cluster ──
  // each bucket is one draw call instead of one-per-point
  // approximate on-screen pixel size for points (scale factor 120 applied in draw())
  let pointPx = Math.max(2, params.pointSize * 120);
  noFill();
  strokeWeight(pointPx);
  for (let b = 0; b < clusterBuckets.length; b++) {
    let bucket = clusterBuckets[b];
    let c = bucket.color;
    stroke(c[0], c[1], c[2], bucket.isText ? 180 : 255);
    beginShape(POINTS);
    let bp = bucket.points;
    if (highlightedSet) {
      for (let i = 0; i < bp.length; i++) {
        let p = bp[i];
        if (highlightedSet.has(p)) continue;
        vertex(p.x, p.y, p.z);
      }
    } else {
      for (let i = 0; i < bp.length; i++) {
        let p = bp[i];
        vertex(p.x, p.y, p.z);
      }
    }
    endShape();
  }

  // ── pass 3: actual sphere/box meshes only for highlighted points ──
  if (highlightedSet) {
    noStroke();
    highlightedSet.forEach((p) => {
      let c = clusterRGB(p.cluster);
      push();
      translate(p.x, p.y, p.z);
      if (p._isText) {
        fill(c[0], c[1], c[2], 180);
        box(params.highlightSize * 1.5);
      } else {
        fill(c[0], c[1], c[2]);
        sphere(params.highlightSize);
      }
      pop();
    });
  }

  // update image preview
  if (params.blendMode !== "off") {
    updateBlendQueue(inRangeImages);
    if (inRangeImages.length > 0) {
      document.getElementById("image-meta").textContent =
        `${inRangeImages.length} images | nearest d=${closestImageDist.toFixed(3)}`;
    } else {
      document.getElementById("image-meta").textContent = "";
    }
  } else {
    document.getElementById("blend-count").textContent = "0";
    if (closestImage && closestImageDist < params.cursorRange) {
      let src = "tomorrow/" + closestImage.source;
      updateImagePreview(src);
      document.getElementById("image-meta").textContent =
        `cluster ${closestImage.cluster} | d=${closestImageDist.toFixed(3)}`;
    } else {
      clearImagePreview();
      document.getElementById("image-meta").textContent = "";
    }
  }

  // update text preview
  if (closestText && closestTextDist < params.cursorRange) {
    updateTextPreview(
      closestText.text,
      `cluster ${closestText.cluster} | d=${closestTextDist.toFixed(3)}`
    );
  } else {
    clearTextPreview();
  }
}

const CLUSTER_COLORS = [
  [255, 99, 132],
  [54, 162, 235],
  [255, 206, 86],
  [75, 192, 192],
  [153, 102, 255],
];

function clusterRGB(cluster) {
  return CLUSTER_COLORS[(cluster || 0) % CLUSTER_COLORS.length];
}

function colorFromCluster(cluster, alpha) {
  let c = clusterRGB(cluster);
  return alpha ? color(c[0], c[1], c[2], alpha) : color(c[0], c[1], c[2]);
}

function drawAxes(size) {
  size = size || 2;
  let r = 0.06, h = 0.15;
  strokeWeight(1);

  // X — red
  stroke(255, 60, 60);
  line(-size, 0, 0, size, 0, 0);
  push(); translate(size, 0, 0); rotateZ(-HALF_PI);
  fill(255, 60, 60); noStroke(); cone(r, h); pop();

  // Y — green
  stroke(60, 255, 60);
  line(0, -size, 0, 0, size, 0);
  push(); translate(0, size, 0);
  fill(60, 255, 60); noStroke(); cone(r, h); pop();

  // Z — blue
  stroke(60, 120, 255);
  line(0, 0, -size, 0, 0, size);
  push(); translate(0, 0, size); rotateX(HALF_PI);
  fill(60, 120, 255); noStroke(); cone(r, h); pop();
}

function drawBoxGrids(steps) {
  steps = steps || 10;
  let x1 = bounds.minX, x2 = bounds.maxX;
  let y1 = bounds.minY, y2 = bounds.maxY;
  let z1 = bounds.minZ, z2 = bounds.maxZ;

  stroke(60, 60, 60, 160);
  strokeWeight(0.3);

  for (let i = 0; i <= steps; i++) {
    let t = i / steps;
    let tx = lerp(x1, x2, t), tz = lerp(z1, z2, t);
    line(tx, y1, z1, tx, y1, z2);
    line(x1, y1, tz, x2, y1, tz);
  }
  for (let i = 0; i <= steps; i++) {
    let t = i / steps;
    let tx = lerp(x1, x2, t), ty = lerp(y1, y2, t);
    line(tx, y1, z1, tx, y2, z1);
    line(x1, ty, z1, x2, ty, z1);
  }
  for (let i = 0; i <= steps; i++) {
    let t = i / steps;
    let ty = lerp(y1, y2, t), tz = lerp(z1, z2, t);
    line(x1, ty, z1, x1, ty, z2);
    line(x1, y1, tz, x1, y2, tz);
  }
}

function drawBoxFaces() {
  let x1 = bounds.minX, x2 = bounds.maxX;
  let y1 = bounds.minY, y2 = bounds.maxY;
  let z1 = bounds.minZ, z2 = bounds.maxZ;

  noStroke();
  fill(50, 50, 50, 120);

  beginShape();
  vertex(x1, y1, z1); vertex(x2, y1, z1);
  vertex(x2, y1, z2); vertex(x1, y1, z2);
  endShape(CLOSE);

  beginShape();
  vertex(x1, y1, z1); vertex(x2, y1, z1);
  vertex(x2, y2, z1); vertex(x1, y2, z1);
  endShape(CLOSE);

  beginShape();
  vertex(x1, y1, z1); vertex(x1, y1, z2);
  vertex(x1, y2, z2); vertex(x1, y2, z1);
  endShape(CLOSE);
}

function drawCursorCrosshair() {
  stroke(255, 220, 0, 60);
  strokeWeight(0.5);
  line(cursor.x, cursor.y, cursor.z, cursor.x, bounds.minY, cursor.z);
  line(cursor.x, cursor.y, cursor.z, cursor.x, cursor.y, bounds.minZ);
  line(cursor.x, cursor.y, cursor.z, bounds.minX, cursor.y, cursor.z);
}
