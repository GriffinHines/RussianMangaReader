(() => {
  if (window.__OCR_RUNNING__) return;
  window.__OCR_RUNNING__ = true;

  let workerPromise = null;
  let isProcessing = false;
  let overlayRoot = null;
  let hud = null;
  let button = null;

  const overlayStore = new Map();

  function ensureHud() {
    if (hud) return hud;

    hud = document.createElement("div");
    hud.style.position = "fixed";
    hud.style.top = "12px";
    hud.style.right = "12px";
    hud.style.zIndex = "2147483647";
    hud.style.background = "rgba(0,0,0,0.85)";
    hud.style.color = "#fff";
    hud.style.padding = "10px 12px";
    hud.style.borderRadius = "8px";
    hud.style.fontSize = "12px";
    hud.style.fontFamily = "Arial, sans-serif";
    hud.style.whiteSpace = "pre-line";
    hud.style.pointerEvents = "none";

    document.documentElement.appendChild(hud);
    return hud;
  }

  function setHud(text) {
    ensureHud().textContent = text;
  }

  function clearHudLater(ms = 2500) {
    setTimeout(() => {
      if (hud) {
        hud.remove();
        hud = null;
      }
    }, ms);
  }

  function ensureButton() {
    if (button) return button;

    button = document.createElement("button");
    button.textContent = "Capture View";
    button.style.position = "fixed";
    button.style.top = "12px";
    button.style.left = "12px";
    button.style.zIndex = "2147483647";
    button.style.background = "#111";
    button.style.color = "#fff";
    button.style.border = "1px solid #444";
    button.style.borderRadius = "8px";
    button.style.padding = "10px 12px";
    button.style.fontSize = "13px";
    button.style.fontFamily = "Arial, sans-serif";
    button.style.cursor = "pointer";
    button.style.boxShadow = "0 2px 8px rgba(0,0,0,0.25)";

    button.addEventListener("mouseenter", () => {
      button.style.background = "#222";
    });

    button.addEventListener("mouseleave", () => {
      button.style.background = "#111";
    });

    button.addEventListener("click", () => {
      processVisiblePanels(true).catch((e) => {
        console.error("OCR capture failed:", e);
        setHud(`OCR failed: ${e.message || e}`);
        clearHudLater(3500);
      });
    });

    document.documentElement.appendChild(button);
    return button;
  }

  function setButtonBusy(busy) {
    const btn = ensureButton();
    btn.disabled = busy;
    btn.textContent = busy ? "Capturing..." : "Capture View";
    btn.style.opacity = busy ? "0.7" : "1";
    btn.style.cursor = busy ? "default" : "pointer";
  }

  function ensureOverlayRoot() {
    if (overlayRoot) return overlayRoot;

    overlayRoot = document.createElement("div");
    overlayRoot.id = "__ocr_overlay_root__";
    overlayRoot.style.position = "fixed";
    overlayRoot.style.left = "0";
    overlayRoot.style.top = "0";
    overlayRoot.style.width = "100vw";
    overlayRoot.style.height = "100vh";
    overlayRoot.style.pointerEvents = "none";
    overlayRoot.style.zIndex = "2147483646";
    overlayRoot.style.overflow = "visible";

    document.documentElement.appendChild(overlayRoot);
    return overlayRoot;
  }

  function clearOverlay() {
    ensureOverlayRoot().replaceChildren();
  }

  function getPanels() {
    return [...document.querySelectorAll("img")].filter((img) => {
      const src = img.currentSrc || img.src || "";
      return (
        /\.(jpg|jpeg|png|webp)(\?|$)/i.test(src) &&
        img.complete &&
        img.naturalWidth > 0 &&
        img.naturalHeight > 0
      );
    });
  }

  function isVisibleEnough(img) {
    const r = img.getBoundingClientRect();
    return (
      r.width > 30 &&
      r.height > 30 &&
      r.bottom > 0 &&
      r.top < window.innerHeight &&
      r.right > 0 &&
      r.left < window.innerWidth
    );
  }

  function key(img) {
    return (img.currentSrc || img.src || "").split("?")[0];
  }

  async function getWorker() {
    if (workerPromise) return workerPromise;

    workerPromise = (async () => {
      const w = await Tesseract.createWorker("rus");
      await w.setParameters({
        tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK,
        preserve_interword_spaces: "1"
      });
      return w;
    })();

    return workerPromise;
  }

  function capture() {
    return new Promise((res, rej) => {
      chrome.runtime.sendMessage({ type: "CAPTURE_VISIBLE_TAB" }, (r) => {
        if (chrome.runtime.lastError) {
          rej(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!r?.ok) {
          rej(new Error(r?.error || "capture failed"));
          return;
        }
        res(r.dataUrl);
      });
    });
  }

  async function loadImage(src) {
    return new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = src;
    });
  }

  async function crop(screenData, img) {
  const screen = await loadImage(screenData);
  const rect = img.getBoundingClientRect();

  const scaleX = screen.naturalWidth / window.innerWidth;
  const scaleY = screen.naturalHeight / window.innerHeight;

  const fullW = Math.max(1, Math.round(rect.width * scaleX));
  const fullH = Math.max(1, Math.round(rect.height * scaleY));

  const visLeft = Math.max(0, rect.left);
  const visTop = Math.max(0, rect.top);
  const visRight = Math.min(window.innerWidth, rect.right);
  const visBottom = Math.min(window.innerHeight, rect.bottom);

  const visW = Math.max(0, visRight - visLeft);
  const visH = Math.max(0, visBottom - visTop);

  const canvas = document.createElement("canvas");
  canvas.width = fullW;
  canvas.height = fullH;

  const ctx = canvas.getContext("2d");

  if (visW > 0 && visH > 0) {
    const sx = visLeft * scaleX;
    const sy = visTop * scaleY;
    const sw = visW * scaleX;
    const sh = visH * scaleY;

    const dx = Math.max(0, -rect.left) * scaleX;
    const dy = Math.max(0, -rect.top) * scaleY;
    const dw = sw;
    const dh = sh;

    ctx.drawImage(screen, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  return canvas;
}

  function preprocessForText(srcCanvas) {
    const canvas = document.createElement("canvas");
    canvas.width = srcCanvas.width * 2;
    canvas.height = srcCanvas.height * 2;

    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(srcCanvas, 0, 0, canvas.width, canvas.height);

    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;

    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];

      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      const v = gray > 185 ? 255 : 0;

      d[i] = v;
      d[i + 1] = v;
      d[i + 2] = v;
      d[i + 3] = 255;
    }

    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  function normalizeEntry(text, bbox, confidence) {
    return {
      text: (text || "").trim(),
      bbox,
      confidence: Number.isFinite(confidence) ? confidence : 0
    };
  }

  function validBox(bbox) {
    return (
      bbox &&
      Number.isFinite(bbox.x0) &&
      Number.isFinite(bbox.y0) &&
      Number.isFinite(bbox.x1) &&
      Number.isFinite(bbox.y1) &&
      bbox.x1 > bbox.x0 &&
      bbox.y1 > bbox.y0
    );
  }

  function parseTSV(tsv) {
    if (!tsv || typeof tsv !== "string") return [];

    const lines = tsv.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return [];

    const header = lines[0].split("\t");
    const idx = Object.fromEntries(header.map((h, i) => [h, i]));
    const out = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split("\t");
      if (cols.length < header.length) continue;

      const text = (cols[idx.text] || "").trim();
      const conf = Number(cols[idx.conf] ?? -1);
      const left = Number(cols[idx.left] ?? 0);
      const top = Number(cols[idx.top] ?? 0);
      const width = Number(cols[idx.width] ?? 0);
      const height = Number(cols[idx.height] ?? 0);

      if (!text) continue;
      if (!Number.isFinite(left) || !Number.isFinite(top)) continue;
      if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
      if (width <= 0 || height <= 0) continue;

      out.push({
        text,
        confidence: Number.isFinite(conf) ? conf : 0,
        bbox: {
          x0: left,
          y0: top,
          x1: left + width,
          y1: top + height
        }
      });
    }

    return out;
  }

  function parseTitleBBox(title) {
    if (!title) return null;

    const m = title.match(/bbox\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/i);
    if (!m) return null;

    return {
      x0: Number(m[1]),
      y0: Number(m[2]),
      x1: Number(m[3]),
      y1: Number(m[4])
    };
  }

  function parseTitleConfidence(title) {
    if (!title) return 0;

    const m = title.match(/x_wconf\s+([-\d.]+)/i);
    if (!m) return 0;

    const v = Number(m[1]);
    return Number.isFinite(v) ? v : 0;
  }

  function parseHOCR(hocr) {
    if (!hocr || typeof hocr !== "string") return [];

    const parser = new DOMParser();
    const doc = parser.parseFromString(hocr, "text/html");
    const out = [];

    const nodes = [
      ...doc.querySelectorAll(".ocrx_word"),
      ...doc.querySelectorAll(".ocr_word"),
      ...doc.querySelectorAll(".ocr_line")
    ];

    for (const node of nodes) {
      const text = (node.textContent || "").trim();
      if (!text) continue;

      const bbox = parseTitleBBox(node.getAttribute("title") || "");
      if (!validBox(bbox)) continue;

      out.push({
        text,
        confidence: parseTitleConfidence(node.getAttribute("title") || ""),
        bbox
      });
    }

    return out;
  }

  function looksLikeRealText(item) {
    const text = (item.text || "").trim();
    if (!text) return false;
    if (!validBox(item.bbox)) return false;

    const w = item.bbox.x1 - item.bbox.x0;
    const h = item.bbox.y1 - item.bbox.y0;
    const ratio = w / Math.max(h, 1);

    if (w < 18 || h < 10) return false;
    if (w > 1400 || h > 180) return false;
    if (ratio < 1.2 || ratio > 20) return false;
    if ((item.confidence || 0) < 45) return false;

    const cleaned = text.replace(/\s+/g, "");
    if (cleaned.length < 2) return false;

    if (!/^[А-Яа-яЁё0-9:;,.!?()'"«»\-–— ]+$/.test(text)) return false;

    const cyr = text.match(/[А-Яа-яЁё]/g) || [];
    if (cyr.length < 2) return false;

    const bad = text.match(/[^А-Яа-яЁё0-9:;,.!?()'"«»\-–— ]/g) || [];
    if (bad.length > 0) return false;

    return true;
  }

  function dedupeBoxes(items) {
    const out = [];

    for (const item of items) {
      const w1 = item.bbox.x1 - item.bbox.x0;
      const h1 = item.bbox.y1 - item.bbox.y0;
      const area1 = w1 * h1;
      const cx1 = (item.bbox.x0 + item.bbox.x1) / 2;
      const cy1 = (item.bbox.y0 + item.bbox.y1) / 2;

      let merged = false;

      for (let i = 0; i < out.length; i++) {
        const other = out[i];
        const w2 = other.bbox.x1 - other.bbox.x0;
        const h2 = other.bbox.y1 - other.bbox.y0;
        const area2 = w2 * h2;
        const cx2 = (other.bbox.x0 + other.bbox.x1) / 2;
        const cy2 = (other.bbox.y0 + other.bbox.y1) / 2;

        const closeX = Math.abs(cx1 - cx2) < Math.max(w1, w2) * 0.4;
        const closeY = Math.abs(cy1 - cy2) < Math.max(h1, h2) * 0.5;

        if (closeX && closeY) {
          const score1 =
            (item.confidence || 0) + Math.min((item.text || "").length * 2, 20);
          const score2 =
            (other.confidence || 0) + Math.min((other.text || "").length * 2, 20);

          if (score1 > score2 || (score1 === score2 && area1 > area2)) {
            out[i] = item;
          }

          merged = true;
          break;
        }
      }

      if (!merged) out.push(item);
    }

    return out;
  }

  function filterLonelyBoxes(items) {
    return items.filter((item) => {
      const cx1 = (item.bbox.x0 + item.bbox.x1) / 2;
      const cy1 = (item.bbox.y0 + item.bbox.y1) / 2;

      let neighbors = 0;

      for (const other of items) {
        if (other === item) continue;

        const cx2 = (other.bbox.x0 + other.bbox.x1) / 2;
        const cy2 = (other.bbox.y0 + other.bbox.y1) / 2;

        if (Math.abs(cx1 - cx2) < 250 && Math.abs(cy1 - cy2) < 80) {
          neighbors++;
        }
      }

      const w = item.bbox.x1 - item.bbox.x0;
      const h = item.bbox.y1 - item.bbox.y0;

      return neighbors > 0 || w > 80 || h > 18;
    });
  }

  function extractTextBoxes(result) {
    const words = result?.data?.words || [];
    const wordItems = words
      .map((w) => normalizeEntry(w.text, w.bbox, w.confidence))
      .filter(looksLikeRealText);
    if (wordItems.length) return wordItems;

    const lines = result?.data?.lines || [];
    const lineItems = lines
      .map((l) => normalizeEntry(l.text, l.bbox, l.confidence))
      .filter(looksLikeRealText);
    if (lineItems.length) return lineItems;

    const tsvItems = parseTSV(result?.data?.tsv).filter(looksLikeRealText);
    if (tsvItems.length) return tsvItems;

    const hocrItems = parseHOCR(result?.data?.hocr).filter(looksLikeRealText);
    if (hocrItems.length) return hocrItems;

    return [];
  }

  function drawViewportBox(x, y, w, h) {
  const root = ensureOverlayRoot();

  const box = document.createElement("div");
  box.style.position = "fixed";
  box.style.left = `${x}px`;
  box.style.top = `${y}px`;
  box.style.width = `${w}px`;
  box.style.height = `${h}px`;

  // 🔵 Blue highlight style
  box.style.background = "rgba(0, 150, 255, 0.25)";
  box.style.outline = "2px solid rgba(0, 150, 255, 0.9)";
  box.style.boxSizing = "border-box";
  box.style.pointerEvents = "none";

  root.appendChild(box);
  }

  function render() {
  clearOverlay();

  for (const img of getPanels()) {
    const stored = overlayStore.get(key(img));
    if (!stored) continue;

    const rect = img.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    const sx = rect.width / stored.sourceWidth;
    const sy = rect.height / stored.sourceHeight;
    const upscale = 2;

    for (const item of stored.items) {
      const x = rect.left + (item.bbox.x0 / upscale) * sx;
      const y = rect.top + (item.bbox.y0 / upscale) * sy;
      const w = ((item.bbox.x1 - item.bbox.x0) / upscale) * sx;
      const h = ((item.bbox.y1 - item.bbox.y0) / upscale) * sy;

      drawViewportBox(x, y, w, h, item.text, item.confidence);
    }
  }
}

  async function processVisiblePanels(forceRefresh = false) {
    if (isProcessing) return;
    isProcessing = true;
    setButtonBusy(true);

    try {
      const panels = getPanels().filter(isVisibleEnough);

      if (!panels.length) {
        setHud("No visible images found");
        clearHudLater();
        return;
      }

      setHud(`Capturing...\n${panels.length} image(s)`);

      const shot = await capture();
      const worker = await getWorker();

      for (let i = 0; i < panels.length; i++) {
        const img = panels[i];
        const k = key(img);

        if (!forceRefresh && overlayStore.has(k)) continue;

        setHud(`Processing...\n${i + 1}/${panels.length}`);

        try {
          const canvas = await crop(shot, img);
          const prep = preprocessForText(canvas);

          const result = await worker.recognize(
            prep,
            {},
            { text: true, tsv: true, hocr: true }
          );

          let items = extractTextBoxes(result);
          items = dedupeBoxes(items);
          items = filterLonelyBoxes(items);

          console.log("OCR TEXT for", k, result?.data?.text);
          console.log("OCR ITEMS for", k, items);

          overlayStore.set(k, {
            items,
            sourceWidth: canvas.width,
            sourceHeight: canvas.height
          });
        } catch (e) {
          console.error("OCR failed for image:", k, e);
        }
      }

      render();
      setHud("OCR complete");
      clearHudLater();
    } finally {
      isProcessing = false;
      setButtonBusy(false);
    }
  }

  window.addEventListener("resize", render);
  window.addEventListener("scroll", render, { passive: true });

  ensureButton();
  ensureOverlayRoot();
})();