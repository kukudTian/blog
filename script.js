const text = {
  processing: "处理中...",
  processAuto: "去除水印",
  processAutoModern: "去除新水印",
  processManual: "去除定位水印",
  download: "下载图片",
  error: "发生错误，请重试。",
  selectArea: "请先在图片上拖动框选水印区域。"
};

const dropArea = document.getElementById("drop-area");
const fileInput = document.getElementById("fileElem");
const modePanel = document.getElementById("modePanel");
const modeTabs = document.querySelector(".mode-tabs");
const autoModeBtn = document.getElementById("autoModeBtn");
const autoModernModeBtn = document.getElementById("autoModernModeBtn");
const manualModeBtn = document.getElementById("manualModeBtn");
const manualHint = document.getElementById("manualHint");
const originalWrap = document.getElementById("originalWrap");
const processedWrap = document.getElementById("processedWrap");
const selectionStage = document.getElementById("selectionStage");
const selectionBox = document.getElementById("selectionBox");
const originalImage = document.getElementById("originalImage");
const processedImage = document.getElementById("processedImage");
const processBtn = document.getElementById("processBtn");
const downloadBtn = document.getElementById("downloadBtn");

let originalDataUrl = null;
let processedDataUrl = null;
let watermarkRemover = null;
let currentMode = "auto";
let selection = null;
let dragStart = null;

function preventDefaults(event) {
  event.preventDefault();
  event.stopPropagation();
}

function highlight() {
  dropArea.classList.add("highlight");
}

function unhighlight() {
  dropArea.classList.remove("highlight");
}

function getWatermarkConfig(width, height) {
  if (width > 1024 && height > 1024) {
    return { logoSize: 96, marginRight: 64, marginBottom: 64 };
  }
  return { logoSize: 48, marginRight: 32, marginBottom: 32 };
}

function getWatermarkArea(width, height, config) {
  const size = config.logoSize;
  return {
    x: width - config.marginRight - size,
    y: height - config.marginBottom - size,
    width: size,
    height: size
  };
}

function getModernWatermarkArea(width, height, logoSize) {
  const referenceWidth = 1792;
  const referenceHeight = 2400;
  const referenceX = 1416;
  const referenceY = 2110;
  return {
    x: Math.round((width * referenceX) / referenceWidth),
    y: Math.round((height * referenceY) / referenceHeight),
    width: logoSize,
    height: logoSize
  };
}

function imageDataToAlphaMap(imageData) {
  const alphaMap = new Float32Array(imageData.width * imageData.height);
  const data = imageData.data;
  for (let index = 0; index < alphaMap.length; index += 1) {
    const offset = index * 4;
    const maxChannel = Math.max(data[offset], data[offset + 1], data[offset + 2]);
    alphaMap[index] = maxChannel / 255;
  }
  return alphaMap;
}

function clampArea(area, imageData) {
  const x = Math.max(0, Math.min(imageData.width - 1, Math.round(area.x)));
  const y = Math.max(0, Math.min(imageData.height - 1, Math.round(area.y)));
  const width = Math.max(1, Math.min(imageData.width - x, Math.round(area.width)));
  const height = Math.max(1, Math.min(imageData.height - y, Math.round(area.height)));
  return { x, y, width, height };
}

function removeWatermarkPixels(imageData, alphaMap, sourceSize, area, options = {}) {
  const data = imageData.data;
  const targetArea = clampArea(area, imageData);
  const alphaThreshold = options.alphaThreshold ?? 0.002;
  const strength = options.strength ?? 1;

  for (let row = 0; row < targetArea.height; row += 1) {
    for (let col = 0; col < targetArea.width; col += 1) {
      const sourceX = Math.min(sourceSize - 1, Math.floor((col / targetArea.width) * sourceSize));
      const sourceY = Math.min(sourceSize - 1, Math.floor((row / targetArea.height) * sourceSize));
      let alpha = alphaMap[sourceY * sourceSize + sourceX];
      if (alpha < alphaThreshold) continue;

      const target = 4 * ((targetArea.y + row) * imageData.width + (targetArea.x + col));
      alpha = Math.min(alpha * strength, 0.99);
      const remaining = 1 - alpha;
      for (let channel = 0; channel < 3; channel += 1) {
        const restored = (data[target + channel] - 255 * alpha) / remaining;
        data[target + channel] = Math.max(0, Math.min(255, Math.round(restored)));
      }
    }
  }
}

function scoreWatermarkCandidate(imageData, alphaMap, sourceSize, x, y) {
  const data = imageData.data;
  let weightedBrightness = 0;
  let weightedSaturation = 0;
  let weight = 0;
  let outsideBrightness = 0;
  let outsideCount = 0;

  for (let row = 0; row < sourceSize; row += 1) {
    for (let col = 0; col < sourceSize; col += 1) {
      const alpha = alphaMap[row * sourceSize + col];
      const target = 4 * ((y + row) * imageData.width + (x + col));
      const red = data[target];
      const green = data[target + 1];
      const blue = data[target + 2];
      const maxChannel = Math.max(red, green, blue);
      const minChannel = Math.min(red, green, blue);

      if (alpha > 0.06) {
        weightedBrightness += maxChannel * alpha;
        weightedSaturation += (maxChannel - minChannel) * alpha;
        weight += alpha;
      } else {
        outsideBrightness += maxChannel;
        outsideCount += 1;
      }
    }
  }

  if (!weight || !outsideCount) return -Infinity;

  const coreBrightness = weightedBrightness / weight;
  const coreSaturation = weightedSaturation / weight;
  const surroundingBrightness = outsideBrightness / outsideCount;
  return (coreBrightness - surroundingBrightness) * 1.8 + coreBrightness * 0.2 - coreSaturation * 0.25;
}

function findManualWatermarkArea(imageData, alphaMap, sourceSize, selectedArea) {
  const area = clampArea(selectedArea, imageData);
  const centerX = area.x + area.width / 2;
  const centerY = area.y + area.height / 2;

  if (area.width < sourceSize * 1.6 && area.height < sourceSize * 1.6) {
    return forceFixedWatermarkArea(imageData, area, sourceSize);
  }

  const minX = Math.max(0, Math.round(area.x));
  const minY = Math.max(0, Math.round(area.y));
  const maxX = Math.min(imageData.width - sourceSize, Math.round(area.x + area.width - sourceSize));
  const maxY = Math.min(imageData.height - sourceSize, Math.round(area.y + area.height - sourceSize));

  if (maxX < minX || maxY < minY) {
    return forceFixedWatermarkArea(imageData, area, sourceSize);
  }

  let bestArea = {
    x: Math.max(0, Math.min(imageData.width - sourceSize, Math.round(centerX - sourceSize / 2))),
    y: Math.max(0, Math.min(imageData.height - sourceSize, Math.round(centerY - sourceSize / 2))),
    width: sourceSize,
    height: sourceSize
  };
  let bestScore = scoreWatermarkCandidate(imageData, alphaMap, sourceSize, bestArea.x, bestArea.y);
  const step = sourceSize >= 96 ? 4 : 2;

  for (let y = minY; y <= maxY; y += step) {
    for (let x = minX; x <= maxX; x += step) {
      const score = scoreWatermarkCandidate(imageData, alphaMap, sourceSize, x, y);
      if (score > bestScore) {
        bestScore = score;
        bestArea = { x, y, width: sourceSize, height: sourceSize };
      }
    }
  }

  return bestArea;
}

function repairWatermarkShapePixels(imageData, alphaMap, sourceSize, area, options = {}) {
  const data = imageData.data;
  const targetArea = clampArea(area, imageData);
  const threshold = options.alphaThreshold ?? 0.04;
  const expand = options.expand ?? 0;
  const mask = new Set();
  let remaining = 0;

  for (let row = 0; row < targetArea.height; row += 1) {
    for (let col = 0; col < targetArea.width; col += 1) {
      const sourceX = Math.min(sourceSize - 1, Math.floor((col / targetArea.width) * sourceSize));
      const sourceY = Math.min(sourceSize - 1, Math.floor((row / targetArea.height) * sourceSize));
      if (alphaMap[sourceY * sourceSize + sourceX] <= threshold) continue;

      for (let dy = -expand; dy <= expand; dy += 1) {
        for (let dx = -expand; dx <= expand; dx += 1) {
          const x = targetArea.x + col + dx;
          const y = targetArea.y + row + dy;
          if (x < 0 || y < 0 || x >= imageData.width || y >= imageData.height) continue;

          const key = y * imageData.width + x;
          if (!mask.has(key)) {
            mask.add(key);
            remaining += 1;
          }
        }
      }
    }
  }

  if (!remaining) return;

  const working = new Uint8ClampedArray(data);
  const filled = new Set();
  const maxIterations = sourceSize + 12;
  const neighbors = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1]
  ];

  for (let iteration = 0; iteration < maxIterations && remaining > 0; iteration += 1) {
    const updates = [];

    mask.forEach((key) => {
      if (filled.has(key)) return;

      const x = key % imageData.width;
      const y = Math.floor(key / imageData.width);
      let red = 0;
      let green = 0;
      let blue = 0;
      let count = 0;

      neighbors.forEach(([dx, dy]) => {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= imageData.width || ny >= imageData.height) return;

        const neighborKey = ny * imageData.width + nx;
        if (mask.has(neighborKey) && !filled.has(neighborKey)) return;

        const offset = neighborKey * 4;
        red += working[offset];
        green += working[offset + 1];
        blue += working[offset + 2];
        count += 1;
      });

      if (count >= 2) {
        updates.push({ key, red: red / count, green: green / count, blue: blue / count });
      }
    });

    if (!updates.length) break;

    updates.forEach(({ key, red, green, blue }) => {
      const offset = key * 4;
      working[offset] = Math.round(red);
      working[offset + 1] = Math.round(green);
      working[offset + 2] = Math.round(blue);
      filled.add(key);
      remaining -= 1;
    });
  }

  mask.forEach((key) => {
    const offset = key * 4;
    data[offset] = working[offset];
    data[offset + 1] = working[offset + 1];
    data[offset + 2] = working[offset + 2];
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

class GeminiWatermarkRemover {
  constructor(bg48, bg96) {
    this.bg48 = bg48;
    this.bg96 = bg96;
    this.alphaMaps = {};
  }

  static async create() {
    const [bg48, bg96] = await Promise.all([
      loadImage("assets/gemini-watermark-remover/bg_48.png"),
      loadImage("assets/gemini-watermark-remover/bg_96.png")
    ]);
    return new GeminiWatermarkRemover(bg48, bg96);
  }

  getAlphaMap(size) {
    if (this.alphaMaps[size]) return this.alphaMaps[size];

    const source = size === 48 ? this.bg48 : this.bg96;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    context.drawImage(source, 0, 0);
    const imageData = context.getImageData(0, 0, size, size);
    const alphaMap = imageDataToAlphaMap(imageData);
    this.alphaMaps[size] = alphaMap;
    return alphaMap;
  }
}

function setMode(mode) {
  currentMode = mode;
  const isManual = mode === "manual";
  const isAutoModern = mode === "autoModern";

  autoModeBtn.classList.toggle("active", mode === "auto");
  autoModernModeBtn.classList.toggle("active", isAutoModern);
  manualModeBtn.classList.toggle("active", isManual);
  selectionStage.classList.toggle("manual-active", isManual);
  manualHint.classList.toggle("hidden", !isManual);
  processBtn.textContent = isManual
    ? text.processManual
    : isAutoModern
      ? text.processAutoModern
      : text.processAuto;

  if (!isManual) {
    selectionBox.classList.add("hidden");
  } else if (selection) {
    drawSelection();
  }
}

function resetResult() {
  processedDataUrl = null;
  processedImage.removeAttribute("src");
  processedWrap.classList.add("hidden");
  processBtn.classList.remove("hidden");
  downloadBtn.classList.add("hidden");
}

function showOriginal(dataUrl) {
  originalDataUrl = dataUrl;
  originalImage.src = dataUrl;
  selection = null;
  selectionBox.classList.add("hidden");
  originalWrap.classList.remove("hidden");
  modePanel.classList.remove("hidden");
  resetResult();
  setMode(currentMode);
}

function handleFile(file) {
  if (!file || !file.type.includes("image/")) return;

  const reader = new FileReader();
  reader.onload = (event) => showOriginal(event.target.result);
  reader.readAsDataURL(file);
}

function getStagePoint(event) {
  const rect = selectionStage.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
    y: Math.max(0, Math.min(rect.height, event.clientY - rect.top))
  };
}

function drawSelection() {
  if (!selection) return;

  selectionBox.style.left = `${selection.x}px`;
  selectionBox.style.top = `${selection.y}px`;
  selectionBox.style.width = `${selection.width}px`;
  selectionBox.style.height = `${selection.height}px`;
  selectionBox.classList.remove("hidden");
}

function updateManualSelection(currentPoint) {
  const rect = selectionStage.getBoundingClientRect();
  const x = Math.max(0, Math.min(dragStart.x, currentPoint.x));
  const y = Math.max(0, Math.min(dragStart.y, currentPoint.y));
  const right = Math.min(rect.width, Math.max(dragStart.x, currentPoint.x));
  const bottom = Math.min(rect.height, Math.max(dragStart.y, currentPoint.y));
  selection = { x, y, width: right - x, height: bottom - y };
  drawSelection();
}

function getSelectionInImagePixels(image) {
  if (!selection || selection.width < 4 || selection.height < 4) return null;

  const rect = originalImage.getBoundingClientRect();
  const scaleX = image.width / rect.width;
  const scaleY = image.height / rect.height;
  return {
    x: selection.x * scaleX,
    y: selection.y * scaleY,
    width: selection.width * scaleX,
    height: selection.height * scaleY
  };
}

function forceFixedWatermarkArea(imageData, area, sourceSize) {
  const centerX = area.x + area.width / 2;
  const centerY = area.y + area.height / 2;
  return {
    x: Math.max(0, Math.min(imageData.width - sourceSize, Math.round(centerX - sourceSize / 2))),
    y: Math.max(0, Math.min(imageData.height - sourceSize, Math.round(centerY - sourceSize / 2))),
    width: sourceSize,
    height: sourceSize
  };
}

async function processImage() {
  if (!originalDataUrl || !watermarkRemover) return;

  processBtn.disabled = true;
  processBtn.textContent = text.processing;

  try {
    const image = await loadImage(originalDataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;

    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);

    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    let config;
    let area;

    if (currentMode === "manual") {
      area = getSelectionInImagePixels(image);
      if (!area) {
        alert(text.selectArea);
        return;
      }
      const expectedSize = getWatermarkConfig(image.width, image.height).logoSize;
      config = { logoSize: expectedSize };
      const alphaMap = watermarkRemover.getAlphaMap(config.logoSize);
      area = findManualWatermarkArea(imageData, alphaMap, config.logoSize, area);
      repairWatermarkShapePixels(imageData, alphaMap, config.logoSize, area, {
        alphaThreshold: 0.04
      });
    } else if (currentMode === "autoModern") {
      config = getWatermarkConfig(image.width, image.height);
      area = getModernWatermarkArea(image.width, image.height, config.logoSize);
      const alphaMap = watermarkRemover.getAlphaMap(config.logoSize);
      repairWatermarkShapePixels(imageData, alphaMap, config.logoSize, area, {
        alphaThreshold: 0.006,
        expand: config.logoSize >= 96 ? 2 : 1
      });
    } else {
      config = getWatermarkConfig(image.width, image.height);
      area = getWatermarkArea(image.width, image.height, config);
      const alphaMap = watermarkRemover.getAlphaMap(config.logoSize);
      removeWatermarkPixels(imageData, alphaMap, config.logoSize, area, {
        alphaThreshold: 0.002,
        strength: 1
      });
    }
    context.putImageData(imageData, 0, 0);

    processedDataUrl = canvas.toDataURL("image/png");
    processedImage.src = processedDataUrl;
    processedWrap.classList.remove("hidden");
    processBtn.classList.add("hidden");
    downloadBtn.classList.remove("hidden");
  } catch (error) {
    console.error(error);
    alert(text.error);
  } finally {
    processBtn.disabled = false;
    processBtn.textContent = currentMode === "manual"
      ? text.processManual
      : currentMode === "autoModern"
        ? text.processAutoModern
        : text.processAuto;
  }
}

function downloadProcessedImage() {
  if (!processedDataUrl) return;

  const link = document.createElement("a");
  link.href = processedDataUrl;
  link.download = "aitian-gemini-watermark-removed.png";
  link.click();
}

["dragenter", "dragover", "dragleave", "drop"].forEach((eventName) => {
  dropArea.addEventListener(eventName, preventDefaults, false);
});

["dragenter", "dragover"].forEach((eventName) => {
  dropArea.addEventListener(eventName, highlight, false);
});

["dragleave", "drop"].forEach((eventName) => {
  dropArea.addEventListener(eventName, unhighlight, false);
});

dropArea.addEventListener("drop", (event) => {
  const files = event.dataTransfer.files;
  if (files.length) handleFile(files[0]);
});

dropArea.addEventListener("paste", (event) => {
  const files = event.clipboardData.files;
  if (files.length) handleFile(files[0]);
});

fileInput.addEventListener("change", (event) => {
  const file = event.target.files && event.target.files[0];
  if (file) handleFile(file);
});

modeTabs.addEventListener("click", (event) => {
  const modeButton = event.target.closest("[data-mode]");
  if (!modeButton) return;
  setMode(modeButton.dataset.mode);
});

selectionStage.addEventListener("pointerdown", (event) => {
  if (currentMode !== "manual" || !originalDataUrl) return;
  event.preventDefault();
  resetResult();
  dragStart = getStagePoint(event);
  selection = { x: dragStart.x, y: dragStart.y, width: 0, height: 0 };
  selectionStage.setPointerCapture(event.pointerId);
  drawSelection();
});

selectionStage.addEventListener("pointermove", (event) => {
  if (!dragStart || currentMode !== "manual") return;
  event.preventDefault();
  updateManualSelection(getStagePoint(event));
});

selectionStage.addEventListener("pointerup", (event) => {
  if (!dragStart || currentMode !== "manual") return;
  event.preventDefault();
  updateManualSelection(getStagePoint(event));
  dragStart = null;
});

selectionStage.addEventListener("pointercancel", () => {
  dragStart = null;
});

processBtn.addEventListener("click", processImage);
downloadBtn.addEventListener("click", downloadProcessedImage);

GeminiWatermarkRemover.create()
  .then((remover) => {
    watermarkRemover = remover;
  })
  .catch((error) => {
    console.error(error);
    alert(text.error);
  });
