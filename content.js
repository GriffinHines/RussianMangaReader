(() => {
  if (window.__OCR_RUNNING__) return;
  window.__OCR_RUNNING__ = true;

  let workerPromise = null;
  let isProcessing = false;
  let overlayRoot = null;
  let hud = null;
  let button = null;
  let hoveredBox = null;

  const overlayStore = new Map();
  const colorStore = new Map();
  const translationCache = new Map();

  let popup = null;
  let selectionMode = false;
  let selectionStart = null;
  let selectionBox = null;
  let bHeld = false;
  let lastPointer = null;

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
    button.textContent = "Help";
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
      setHud(
        [
          "Key commands:",
          "B = hold and drag to OCR a selected area",
          "Shift+B = OCR the whole visible screen",
          "G = open the hovered word",
          "Esc = cancel selection / close popup"
        ].join("\n")
      );
      clearHudLater(20000);
    });

    document.documentElement.appendChild(button);
    return button;
  }

  function setButtonBusy(busy) {
    const btn = ensureButton();
    btn.disabled = busy;
    btn.textContent = "Help";
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

  function ensureSelectionBox() {
    if (selectionBox) return selectionBox;

    selectionBox = document.createElement("div");
    selectionBox.style.position = "fixed";
    selectionBox.style.border = "2px dashed #4da3ff";
    selectionBox.style.background = "rgba(77,163,255,0.15)";
    selectionBox.style.pointerEvents = "none";
    selectionBox.style.zIndex = "2147483647";
    selectionBox.style.display = "none";

    document.documentElement.appendChild(selectionBox);
    return selectionBox;
  }

  function startSelectionMode() {
    selectionMode = true;
    selectionStart = null;
    ensureSelectionBox().style.display = "none";
    setHud("Hold B and drag");
  }

  function stopSelectionMode() {
    selectionMode = false;
    selectionStart = null;
    if (selectionBox) selectionBox.style.display = "none";
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
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  async function cropRectFromScreen(screenData, rect) {
    const screen = await loadImage(screenData);

    const scaleX = screen.naturalWidth / window.innerWidth;
    const scaleY = screen.naturalHeight / window.innerHeight;

    const sx = Math.max(0, rect.left * scaleX);
    const sy = Math.max(0, rect.top * scaleY);
    const sw = Math.max(1, rect.width * scaleX);
    const sh = Math.max(1, rect.height * scaleY);

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sw);
    canvas.height = Math.round(sh);

    const ctx = canvas.getContext("2d");
    ctx.drawImage(
      screen,
      sx,
      sy,
      sw,
      sh,
      0,
      0,
      canvas.width,
      canvas.height
    );

    return canvas;
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

      ctx.drawImage(screen, sx, sy, sw, sh, dx, dy, sw, sh);
    }

    return canvas;
  }

  function preprocessForText(srcCanvas) {
    const canvas = document.createElement("canvas");
    canvas.width = srcCanvas.width * 3;
    canvas.height = srcCanvas.height * 3;

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
      const v = gray > 160 ? 255 : 0;

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

    if (w < 4 || h < 4) return false;
    if (w > 2200 || h > 320) return false;
    if (ratio < 0.1 || ratio > 80) return false;
    if ((item.confidence || 0) < 1) return false;

    const cleaned = text.replace(/\s+/g, "");
    if (cleaned.length < 1) return false;

    if (!/[А-Яа-яЁё]/.test(text) && cleaned.length < 2) return false;

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

        if (Math.abs(cx1 - cx2) < 320 && Math.abs(cy1 - cy2) < 140) {
          neighbors++;
        }
      }

      const w = item.bbox.x1 - item.bbox.x0;
      const h = item.bbox.y1 - item.bbox.y0;
      const textLen = (item.text || "").replace(/\s+/g, "").length;
      const hasCyrillic = /[А-Яа-яЁё]/.test(item.text || "");

      return (
        neighbors > 0 ||
        hasCyrillic ||
        textLen >= 1 ||
        w > 12 ||
        h > 8
      );
    });
  }

  function extractTextBoxes(result) {
    const words = (result?.data?.words || [])
      .map((w) => normalizeEntry(w.text, w.bbox, w.confidence))
      .filter(looksLikeRealText)
      .sort((a, b) => {
        const ah = Math.max(1, a.bbox.y1 - a.bbox.y0);
        const bh = Math.max(1, b.bbox.y1 - b.bbox.y0);
        const lineTolerance = Math.max(12, Math.min(ah, bh) * 0.8);

        if (Math.abs(a.bbox.y0 - b.bbox.y0) > lineTolerance) {
          return a.bbox.y0 - b.bbox.y0;
        }
        return a.bbox.x0 - b.bbox.x0;
      });

    const mergedWords = [];

    for (let i = 0; i < words.length; i++) {
      let current = words[i];
      let currentText = (current.text || "").trim();

      while (currentText.endsWith("-") && i + 1 < words.length) {
        const next = words[i + 1];
        const nextText = (next.text || "").trim();

        if (!/^[A-Za-zА-Яа-яЁё]/.test(nextText)) break;

        current = {
          ...current,
          text: currentText.slice(0, -1) + nextText,
          bbox: {
            x0: Math.min(current.bbox.x0, next.bbox.x0),
            y0: Math.min(current.bbox.y0, next.bbox.y0),
            x1: Math.max(current.bbox.x1, next.bbox.x1),
            y1: Math.max(current.bbox.y1, next.bbox.y1)
          },
          confidence: Math.min(current.confidence || 0, next.confidence || 0)
        };

        currentText = current.text;
        i++;
      }

      mergedWords.push(current);
    }

    if (mergedWords.length) {
      return dedupeBoxes(mergedWords);
    }

    const tsvItems = parseTSV(result?.data?.tsv || "")
      .filter(looksLikeRealText)
      .sort((a, b) => {
        const ah = Math.max(1, a.bbox.y1 - a.bbox.y0);
        const bh = Math.max(1, b.bbox.y1 - b.bbox.y0);
        const lineTolerance = Math.max(12, Math.min(ah, bh) * 0.8);

        if (Math.abs(a.bbox.y0 - b.bbox.y0) > lineTolerance) {
          return a.bbox.y0 - b.bbox.y0;
        }
        return a.bbox.x0 - b.bbox.x0;
      });

    if (tsvItems.length) {
      const mergedTsv = [];

      for (let i = 0; i < tsvItems.length; i++) {
        let current = tsvItems[i];
        let currentText = (current.text || "").trim();

        while (currentText.endsWith("-") && i + 1 < tsvItems.length) {
          const next = tsvItems[i + 1];
          const nextText = (next.text || "").trim();

          if (!/^[A-Za-zА-Яа-яЁё]/.test(nextText)) break;

          current = {
            ...current,
            text: currentText.slice(0, -1) + nextText,
            bbox: {
              x0: Math.min(current.bbox.x0, next.bbox.x0),
              y0: Math.min(current.bbox.y0, next.bbox.y0),
              x1: Math.max(current.bbox.x1, next.bbox.x1),
              y1: Math.max(current.bbox.y1, next.bbox.y1)
            },
            confidence: Math.min(current.confidence || 0, next.confidence || 0)
          };

          currentText = current.text;
          i++;
        }

        mergedTsv.push(current);
      }

      return dedupeBoxes(mergedTsv);
    }

    const hocrItems = parseHOCR(result?.data?.hocr || "")
      .filter(looksLikeRealText)
      .sort((a, b) => {
        const ah = Math.max(1, a.bbox.y1 - a.bbox.y0);
        const bh = Math.max(1, b.bbox.y1 - b.bbox.y0);
        const lineTolerance = Math.max(12, Math.min(ah, bh) * 0.8);

        if (Math.abs(a.bbox.y0 - b.bbox.y0) > lineTolerance) {
          return a.bbox.y0 - b.bbox.y0;
        }
        return a.bbox.x0 - b.bbox.x0;
      });

    const mergedHocr = [];

    for (let i = 0; i < hocrItems.length; i++) {
      let current = hocrItems[i];
      let currentText = (current.text || "").trim();

      while (currentText.endsWith("-") && i + 1 < hocrItems.length) {
        const next = hocrItems[i + 1];
        const nextText = (next.text || "").trim();

        if (!/^[A-Za-zА-Яа-яЁё]/.test(nextText)) break;

        current = {
          ...current,
          text: currentText.slice(0, -1) + nextText,
          bbox: {
            x0: Math.min(current.bbox.x0, next.bbox.x0),
            y0: Math.min(current.bbox.y0, next.bbox.y0),
            x1: Math.max(current.bbox.x1, next.bbox.x1),
            y1: Math.max(current.bbox.y1, next.bbox.y1)
          },
          confidence: Math.min(current.confidence || 0, next.confidence || 0)
        };

        currentText = current.text;
        i++;
      }

      mergedHocr.push(current);
    }

    return dedupeBoxes(mergedHocr);
  }

  function makeHighlightKey(imageKey, item) {
    const b = item?.bbox || {};
    return [
      imageKey,
      item?.text || "",
      Math.round(b.x0 || 0),
      Math.round(b.y0 || 0),
      Math.round(b.x1 || 0),
      Math.round(b.y1 || 0)
    ].join("|");
  }

  function getSavedColor(highlightKey) {
    return colorStore.get(highlightKey) || "new";
  }

  function saveColor(highlightKey, colorName) {
    colorStore.set(highlightKey, colorName);
  }

  function getHighlightColors(colorName) {
    switch (colorName) {
      case "seen":
        return {
          fill: "rgba(255, 230, 0, 0.35)",
          outline: "rgba(255, 210, 0, 0.9)"
        };
      case "familiar":
        return {
          fill: "rgba(255, 240, 120, 0.28)",
          outline: "rgba(255, 230, 80, 0.9)"
        };
      case "known":
        return {
          fill: "rgba(255, 250, 180, 0.22)",
          outline: "rgba(255, 240, 140, 0.85)"
        };
      case "new":
      default:
        return {
          fill: "rgba(0, 150, 255, 0.25)",
          outline: "rgba(0, 150, 255, 0.9)"
        };
    }
  }

  function applyHighlightColor(box, colorName) {
    const c = getHighlightColors(colorName);
    box.style.background = c.fill;
    box.style.outline = `2px solid ${c.outline}`;
  }

  async function translateWordToEnglish(word) {
    const text = (word || "").trim();
    if (!text) return "";

    const cacheKey = text.toLowerCase();
    if (translationCache.has(cacheKey)) {
      return translationCache.get(cacheKey);
    }

    const url =
      "https://translate.googleapis.com/translate_a/single" +
      `?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(text)}`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Translation failed: HTTP ${res.status}`);
    }

    const data = await res.json();
    const translated = Array.isArray(data?.[0])
      ? data[0].map((part) => part?.[0] || "").join("").trim()
      : "";

    translationCache.set(cacheKey, translated);
    return translated;
  }

  function decodeHtmlEntities(str) {
    const t = document.createElement("textarea");
    t.innerHTML = str || "";
    return t.value;
  }

  function drawViewportBox(x, y, w, h, text, highlightKey) {
    const root = ensureOverlayRoot();
    const box = document.createElement("div");
    box.style.position = "fixed";
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
    box.style.boxSizing = "border-box";
    box.style.borderRadius = "3px";
    box.style.pointerEvents = "auto";
    box.style.cursor = "pointer";

    box.dataset.word = text || "";
    box.dataset.highlightKey = highlightKey || "";

    applyHighlightColor(box, getSavedColor(highlightKey));

    box.addEventListener("click", (e) => {
      e.stopPropagation();
      showPopupForBox(box, box.dataset.word, e.clientX, e.clientY);
    });

    root.appendChild(box);

    box.addEventListener("mouseenter", () => {
      hoveredBox = box;
    });

    box.addEventListener("mouseleave", () => {
      if (hoveredBox === box) hoveredBox = null;
    });
  }

  function ensurePopup() {
    if (popup) return popup;

    popup = document.createElement("div");
    popup.style.position = "fixed";
    popup.style.zIndex = "2147483647";
    popup.style.background = "rgba(20,20,20,0.96)";
    popup.style.color = "#fff";
    popup.style.border = "1px solid #444";
    popup.style.borderRadius = "10px";
    popup.style.padding = "10px";
    popup.style.font = "13px Arial";
    popup.style.display = "none";
    popup.style.pointerEvents = "auto";

    document.documentElement.appendChild(popup);
    return popup;
  }

  function updateBoxWord(box, newWord) {
    const cleaned = (newWord || "").trim();
    if (!cleaned) return false;

    const oldKey = box.dataset.highlightKey || "";
    const oldColor = getSavedColor(oldKey);

    box.dataset.word = cleaned;

    const left = parseFloat(box.style.left) || 0;
    const top = parseFloat(box.style.top) || 0;
    const width = parseFloat(box.style.width) || 0;
    const height = parseFloat(box.style.height) || 0;

    const newKey = [
      "manual",
      cleaned,
      Math.round(left),
      Math.round(top),
      Math.round(left + width),
      Math.round(top + height)
    ].join("|");

    box.dataset.highlightKey = newKey;

    if (oldKey && oldKey !== newKey && colorStore.has(oldKey)) {
      colorStore.delete(oldKey);
    }

    if (oldColor && oldColor !== "new") {
      colorStore.set(newKey, oldColor);
      applyHighlightColor(box, oldColor);
    }

    return true;
  }

  function createMiniEditUI(box, titleEl, popupEl) {
    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.alignItems = "center";
    wrap.style.gap = "6px";
    wrap.style.marginTop = "8px";

    const input = document.createElement("input");
    input.type = "text";
    input.value = box.dataset.word || "";
    input.style.background = "#111";
    input.style.color = "#fff";
    input.style.border = "1px solid #444";
    input.style.borderRadius = "6px";
    input.style.padding = "5px 8px";
    input.style.font = "12px Arial";
    input.style.width = "120px";
    input.style.outline = "none";

    const saveBtn = document.createElement("button");
    saveBtn.textContent = "Save";
    saveBtn.style.padding = "4px 8px";
    saveBtn.style.cursor = "pointer";
    saveBtn.style.background = "#111";
    saveBtn.style.color = "#fff";
    saveBtn.style.border = "1px solid #444";
    saveBtn.style.borderRadius = "6px";
    saveBtn.style.font = "12px Arial";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.padding = "4px 8px";
    cancelBtn.style.cursor = "pointer";
    cancelBtn.style.background = "#111";
    cancelBtn.style.color = "#fff";
    cancelBtn.style.border = "1px solid #444";
    cancelBtn.style.borderRadius = "6px";
    cancelBtn.style.font = "12px Arial";

    function closeEditor() {
      wrap.remove();
    }

    function saveEdit() {
      const cleaned = input.value.trim();
      if (!cleaned) return;

      updateBoxWord(box, cleaned);
      titleEl.textContent = cleaned;

      const translationEl = popupEl && popupEl.querySelector
        ? popupEl.querySelector("[data-translation]")
        : null;

      if (translationEl) {
        translationEl.textContent = "Translating...";
        translateWordToEnglish(cleaned)
          .then((translated) => {
            if ((box.dataset.word || "") !== cleaned) return;
            translationEl.textContent = translated
              ? decodeHtmlEntities(translated)
              : "(no translation)";
          })
          .catch((err) => {
            console.error("Translation error:", err);
            translationEl.textContent = "(translation failed)";
          });
      }

      closeEditor();
    }

    saveBtn.onclick = (e) => {
      e.stopPropagation();
      saveEdit();
    };

    cancelBtn.onclick = (e) => {
      e.stopPropagation();
      closeEditor();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        saveEdit();
      }
    });

    wrap.appendChild(input);
    wrap.appendChild(saveBtn);
    wrap.appendChild(cancelBtn);
    popupEl.appendChild(wrap);

    input.focus();
    input.select();
  }

  function showPopupForBox(box, word, x, y) {
    const el = ensurePopup();
    el.innerHTML = "";
    el.style.position = "fixed";

    const close = document.createElement("div");
    close.textContent = "✕";
    close.style.position = "absolute";
    close.style.top = "6px";
    close.style.right = "8px";
    close.style.cursor = "pointer";
    close.style.fontSize = "14px";
    close.style.opacity = "0.8";

    close.onclick = (e) => {
      e.stopPropagation();
      el.style.display = "none";
    };

    close.onmouseenter = () => {
      close.style.opacity = "1";
    };

    close.onmouseleave = () => {
      close.style.opacity = "0.8";
    };

    const titleRow = document.createElement("div");
    titleRow.style.display = "flex";
    titleRow.style.alignItems = "center";
    titleRow.style.gap = "8px";
    titleRow.style.marginBottom = "4px";
    titleRow.style.paddingRight = "20px";

    const title = document.createElement("div");
    title.textContent = box.dataset.word || word || "";
    title.style.fontWeight = "bold";
    title.style.flex = "1";

    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.style.padding = "4px 8px";
    editBtn.style.cursor = "pointer";
    editBtn.style.background = "#111";
    editBtn.style.color = "#fff";
    editBtn.style.border = "1px solid #444";
    editBtn.style.borderRadius = "6px";
    editBtn.style.font = "12px Arial";

    editBtn.onclick = (e) => {
      e.stopPropagation();

      const existing = el ? el.querySelector("input[type='text']") : null;
      if (existing) return;

      createMiniEditUI(box, title, el);
    };

    titleRow.appendChild(title);
    titleRow.appendChild(editBtn);

    const translationEl = document.createElement("div");
    translationEl.dataset.translation = "1";
    translationEl.textContent = "Translating...";
    translationEl.style.marginTop = "0";
    translationEl.style.marginBottom = "10px";
    translationEl.style.opacity = "0.8";
    translationEl.style.fontSize = "12px";
    translationEl.style.color = "#cfcfcf";

    const colors = ["new", "seen", "familiar", "known"];

    const row = document.createElement("div");
    row.style.display = "grid";
    row.style.gridTemplateColumns = "1fr 1fr";
    row.style.gap = "6px";

    for (const c of colors) {
      const btn = document.createElement("button");
      btn.textContent = c;
      btn.style.padding = "6px";
      btn.style.cursor = "pointer";
      btn.style.background = "#111";
      btn.style.color = "#fff";
      btn.style.border = "1px solid #444";
      btn.style.borderRadius = "6px";
      btn.style.font = "12px Arial";

      btn.onclick = (e) => {
        e.stopPropagation();
        applyHighlightColor(box, c);

        const highlightKey = box.dataset.highlightKey || "";
        if (highlightKey) saveColor(highlightKey, c);
      };

      row.appendChild(btn);
    }

    el.appendChild(close);
    el.appendChild(titleRow);
    el.appendChild(translationEl);
    el.appendChild(row);

    el.style.display = "block";

    const currentWord = box.dataset.word || word || "";
    translationEl.textContent = "Translating...";

    translateWordToEnglish(currentWord)
      .then((translated) => {
        if ((box.dataset.word || "") !== currentWord) return;
        translationEl.textContent = translated
          ? decodeHtmlEntities(translated)
          : "(no translation)";
      })
      .catch((err) => {
        console.error("Translation error:", err);
        translationEl.textContent = "(translation failed)";
      });

    const margin = 12;
    const rect = el.getBoundingClientRect();

    let left = x + 10;
    let top = y + 10;

    if (left + rect.width > window.innerWidth - margin) {
      left = x - rect.width - 10;
    }

    if (top + rect.height > window.innerHeight - margin) {
      top = y - rect.height - 10;
    }

    el.style.left = `${Math.max(margin, left)}px`;
    el.style.top = `${Math.max(margin, top)}px`;
  }

  document.addEventListener(
    "mousemove",
    (e) => {
      lastPointer = { x: e.clientX, y: e.clientY };

      if (!bHeld || !selectionMode) return;

      const box = ensureSelectionBox();

      if (!selectionStart) {
        selectionStart = { x: e.clientX, y: e.clientY };
        box.style.left = `${e.clientX}px`;
        box.style.top = `${e.clientY}px`;
        box.style.width = "0px";
        box.style.height = "0px";
        box.style.display = "block";
        return;
      }

      const left = Math.min(selectionStart.x, e.clientX);
      const top = Math.min(selectionStart.y, e.clientY);
      const width = Math.abs(e.clientX - selectionStart.x);
      const height = Math.abs(e.clientY - selectionStart.y);

      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
      box.style.width = `${width}px`;
      box.style.height = `${height}px`;
    },
    true
  );

  document.addEventListener(
    "keydown",
    (e) => {
      const ae = document.activeElement;
      const tag = ae?.tagName;

      if (tag === "INPUT" || tag === "TEXTAREA" || ae?.isContentEditable) {
        return;
      }

      if (
        ((e.key === "b" || e.key === "B") || (e.key === "б" || e.key === "Б")) &&
        !e.repeat
      ) {
        e.preventDefault();
        e.stopPropagation();

        if (e.shiftKey) {
          bHeld = false;
          stopSelectionMode();
          processWholeVisibleScreen();
          return;
        }

        bHeld = true;
        startSelectionMode();

        if (lastPointer) {
          selectionStart = { ...lastPointer };
          const box = ensureSelectionBox();
          box.style.left = `${lastPointer.x}px`;
          box.style.top = `${lastPointer.y}px`;
          box.style.width = "0px";
          box.style.height = "0px";
          box.style.display = "block";
        }

        return;
      }

      if (((e.key === "g" || e.key === "G") || (e.key === "г" || e.key === "Г")) && !e.repeat) {
        if (hoveredBox) {
          const rect = hoveredBox.getBoundingClientRect();
          showPopupForBox(
            hoveredBox,
            hoveredBox.dataset.word,
            rect.left + rect.width / 2,
            rect.top + rect.height / 2
          );
        }
        return;
      }

      if (e.key === "Escape") {
        bHeld = false;
        stopSelectionMode();

        if (popup) popup.style.display = "none";

        setHud("Selection cancelled");
        clearHudLater();
      }
    },
    true
  );

  document.addEventListener(
    "keyup",
    (e) => {
      if (!["b", "B", "б", "Б"].includes(e.key)) return;

      e.preventDefault();
      e.stopPropagation();

      if (e.shiftKey) return;

      bHeld = false;

      if (!selectionStart || !selectionBox) {
        stopSelectionMode();
        clearHudLater();
        return;
      }

      const rect = selectionBox.getBoundingClientRect();
      const sel = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      };

      stopSelectionMode();

      if (sel.width < 8 || sel.height < 8) {
        setHud("Selection too small");
        clearHudLater();
        return;
      }

      processSelectedArea(sel);
    },
    true
  );

  document.addEventListener("click", (e) => {
    if (!popup) return;
    if (!popup.contains(e.target)) popup.style.display = "none";
  });

  function render() {
    clearOverlay();

    for (const img of getPanels()) {
      const stored = overlayStore.get(key(img));
      if (!stored) continue;

      const rect = img.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      const sx = rect.width / stored.sourceWidth;
      const sy = rect.height / stored.sourceHeight;
      const upscale = 3;
      const imageKey = key(img);

      for (const item of stored.items) {
        const x = rect.left + (item.bbox.x0 / upscale) * sx;
        const y = rect.top + (item.bbox.y0 / upscale) * sy;
        const w = ((item.bbox.x1 - item.bbox.x0) / upscale) * sx;
        const h = ((item.bbox.y1 - item.bbox.y0) / upscale) * sy;
        const highlightKey = makeHighlightKey(imageKey, item);

        drawViewportBox(x, y, w, h, item.text, highlightKey);
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

      const total = panels.length;
      let done = 0;

      setHud(`Capturing...\n0/${total} (0%)`);

      const shot = await capture();
      const worker = await getWorker();

      for (let i = 0; i < panels.length; i++) {
        const img = panels[i];
        const k = key(img);

        if (!forceRefresh && overlayStore.has(k)) {
          done++;
          const pct = Math.round((done / total) * 100);
          setHud(`Loading OCR...\n${done}/${total} (${pct}%)`);
          continue;
        }

        const current = i + 1;
        setHud(
          `Processing image ${current}/${total}...\n${done}/${total} (${Math.round(
            (done / total) * 100
          )}%)`
        );

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

        done++;
        const pct = Math.round((done / total) * 100);
        setHud(`Loading OCR...\n${done}/${total} (${pct}%)`);
      }

      setHud(`Rendering...\n${done}/${total} (100%)`);
      render();

      setHud("OCR complete\n100%");
      clearHudLater();
    } finally {
      isProcessing = false;
      setButtonBusy(false);
    }
  }

  async function processSelectedArea(rect) {
    if (isProcessing) return;
    isProcessing = true;
    setButtonBusy(true);

    try {
      setHud("Capturing selection...");

      const shot = await capture();
      const worker = await getWorker();

      const canvas = await cropRectFromScreen(shot, rect);
      const prep = preprocessForText(canvas);

      setHud("Running OCR on selection...");

      const result = await worker.recognize(
        prep,
        {},
        { text: true, tsv: true, hocr: true }
      );

      let items = extractTextBoxes(result);
      items = dedupeBoxes(items);
      items = filterLonelyBoxes(items);

      clearOverlay();

      const upscale = 3;
      const sx = rect.width / canvas.width;
      const sy = rect.height / canvas.height;
      const imageKey = `selection:${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}`;

      for (const item of items) {
        const x = rect.left + (item.bbox.x0 / upscale) * sx;
        const y = rect.top + (item.bbox.y0 / upscale) * sy;
        const w = ((item.bbox.x1 - item.bbox.x0) / upscale) * sx;
        const h = ((item.bbox.y1 - item.bbox.y0) / upscale) * sy;
        const highlightKey = makeHighlightKey(imageKey, item);

        drawViewportBox(x, y, w, h, item.text, highlightKey);
      }

      setHud(`Selection OCR complete\n${items.length} boxes`);
      clearHudLater();
    } catch (e) {
      console.error("Selected area OCR failed:", e);
      setHud(`Selection OCR failed:\n${e.message || e}`);
      clearHudLater(3500);
    } finally {
      isProcessing = false;
      setButtonBusy(false);
    }
  }

  async function processWholeVisibleScreen() {
    if (isProcessing) return;
    isProcessing = true;
    setButtonBusy(true);

    try {
      setHud("Capturing visible screen...");

      const shot = await capture();
      const worker = await getWorker();

      const rect = {
        left: 0,
        top: 0,
        width: window.innerWidth,
        height: window.innerHeight
      };

      const canvas = await cropRectFromScreen(shot, rect);
      const prep = preprocessForText(canvas);

      setHud("Running OCR on visible screen...");

      const result = await worker.recognize(
        prep,
        {},
        { text: true, tsv: true, hocr: true }
      );

      let items = extractTextBoxes(result);
      items = dedupeBoxes(items);
      items = filterLonelyBoxes(items);

      clearOverlay();

      const upscale = 3;
      const sx = rect.width / canvas.width;
      const sy = rect.height / canvas.height;
      const imageKey = `viewport:${window.innerWidth}x${window.innerHeight}`;

      for (const item of items) {
        const x = rect.left + (item.bbox.x0 / upscale) * sx;
        const y = rect.top + (item.bbox.y0 / upscale) * sy;
        const w = ((item.bbox.x1 - item.bbox.x0) / upscale) * sx;
        const h = ((item.bbox.y1 - item.bbox.y0) / upscale) * sy;
        const highlightKey = makeHighlightKey(imageKey, item);

        drawViewportBox(x, y, w, h, item.text, highlightKey);
      }

      setHud(`Visible screen OCR complete\n${items.length} boxes`);
      clearHudLater();
    } catch (e) {
      console.error("Visible screen OCR failed:", e);
      setHud(`Visible screen OCR failed:\n${e.message || e}`);
      clearHudLater(3500);
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