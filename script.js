const text = {
  processing: "处理中...",
  processAuto: "去除水印",
  processManual: "去除框选区域水印",
  download: "下载图片",
  error: "发生错误，请重试。",
  selectArea: "请先在图片上拖动框选水印区域。"
};

const dropArea = document.getElementById("drop-area");
const fileInput = document.getElementById("fileElem");
const modePanel = document.getElementById("modePanel");
const autoModeBtn = document.getElementById("autoModeBtn");
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
  const protectDarkPixels = options.protectDarkPixels ?? false;

  for (let row = 0; row < targetArea.height; row += 1) {
    for (let col = 0; col < targetArea.width; col += 1) {
      const sourceX = Math.min(sourceSize - 1, Math.floor((col / targetArea.width) * sourceSize));
      const sourceY = Math.min(sourceSize - 1, Math.floor((row / targetArea.height) * sourceSize));
      let alpha = alphaMap[sourceY * sourceSize + sourceX];
      if (alpha < alphaThreshold) continue;

      const target = 4 * ((targetArea.y + row) * imageData.width + (targetArea.x + col));
      alpha = Math.min(alpha * strength, 0.99);
      if (protectDarkPixels) {
        const maxSafeAlpha = Math.min(data[target], data[target + 1], data[target + 2]) / 255 * 0.88;
        alpha = Math.min(alpha, maxSafeAlpha);
        if (alpha < alphaThreshold) continue;
      }
      const remaining = 1 - alpha;
      for (let channel = 0; channel < 3; channel += 1) {
        const restored = (data[target + channel] - 255 * alpha) / remaining;
        data[target + channel] = Math.max(0, Math.min(255, Math.round(restored)));
      }
    }
  }
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

  autoModeBtn.classList.toggle("active", !isManual);
  manualModeBtn.classList.toggle("active", isManual);
  selectionStage.classList.toggle("manual-active", isManual);
  manualHint.classList.toggle("hidden", !isManual);
  processBtn.textContent = isManual ? text.processManual : text.processAuto;

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

function updateSelection(start, end) {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  selection = { x, y, width, height };
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

function getLuma(data, offset) {
  return (0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2]) / 255;
}

function scoreWatermarkCandidate(imageData, alphaMap, sourceSize, area) {
  const data = imageData.data;
  const step = sourceSize >= 96 ? 3 : 2;
  let count = 0;
  let sumAlpha = 0;
  let sumLuma = 0;
  let sumAlphaSq = 0;
  let sumLumaSq = 0;
  let sumAlphaLuma = 0;
  let brightWeight = 0;
  let alphaWeight = 0;

  for (let row = 0; row < sourceSize; row += step) {
    for (let col = 0; col < sourceSize; col += step) {
      const alpha = alphaMap[row * sourceSize + col];
      if (alpha < 0.04) continue;

      const target = 4 * ((area.y + row) * imageData.width + (area.x + col));
      const luma = getLuma(data, target);
      count += 1;
      sumAlpha += alpha;
      sumLuma += luma;
      sumAlphaSq += alpha * alpha;
      sumLumaSq += luma * luma;
      sumAlphaLuma += alpha * luma;

      if (alpha > 0.16) {
        brightWeight += luma * alpha;
        alphaWeight += alpha;
      }
    }
  }

  if (count < 12 || !alphaWeight) return -Infinity;

  const covariance = sumAlphaLuma - (sumAlpha * sumLuma) / count;
  const alphaVariance = sumAlphaSq - (sumAlpha * sumAlpha) / count;
  const lumaVariance = sumLumaSq - (sumLuma * sumLuma) / count;
  const correlation = covariance / Math.sqrt(Math.max(alphaVariance * lumaVariance, 0.000001));
  const weightedBrightness = brightWeight / alphaWeight;

  return correlation * 0.8 + weightedBrightness * 0.2;
}

function findWatermarkAreaInSelection(imageData, alphaMap, sourceSize, selectedArea) {
  const searchArea = clampArea(selectedArea, imageData);
  if (searchArea.width < sourceSize || searchArea.height < sourceSize) {
    const centerX = searchArea.x + searchArea.width / 2;
    const centerY = searchArea.y + searchArea.height / 2;
    return {
      area: {
        x: Math.max(0, Math.min(imageData.width - sourceSize, Math.round(centerX - sourceSize / 2))),
        y: Math.max(0, Math.min(imageData.height - sourceSize, Math.round(centerY - sourceSize / 2))),
        width: sourceSize,
        height: sourceSize
      },
      score: 1
    };
  }

  const stride = sourceSize >= 96 ? 4 : 3;
  const maxX = searchArea.x + searchArea.width - sourceSize;
  const maxY = searchArea.y + searchArea.height - sourceSize;
  let best = { area: null, score: -Infinity };

  for (let y = searchArea.y; y <= maxY; y += stride) {
    for (let x = searchArea.x; x <= maxX; x += stride) {
      const area = { x, y, width: sourceSize, height: sourceSize };
      const score = scoreWatermarkCandidate(imageData, alphaMap, sourceSize, area);
      if (score > best.score) {
        best = { area, score };
      }
    }
  }

  return best;
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
      const manualAlphaMap = watermarkRemover.getAlphaMap(config.logoSize);
      const match = findWatermarkAreaInSelection(imageData, manualAlphaMap, config.logoSize, area);
      if (!match.area || match.score < 0.18) {
        alert("没有在框选区域里找到明显的 Gemini 水印，请把选区缩小到水印附近再试。");
        return;
      }
      area = forceFixedWatermarkArea(imageData, match.area, config.logoSize);
    } else {
      config = getWatermarkConfig(image.width, image.height);
      area = getWatermarkArea(image.width, image.height, config);
    }

    const alphaMap = watermarkRemover.getAlphaMap(config.logoSize);
    removeWatermarkPixels(imageData, alphaMap, config.logoSize, area, {
      alphaThreshold: currentMode === "manual" ? 0.06 : 0.002,
      strength: currentMode === "manual" ? 0.82 : 1,
      protectDarkPixels: currentMode === "manual"
    });
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
    processBtn.textContent = currentMode === "manual" ? text.processManual : text.processAuto;
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

autoModeBtn.addEventListener("click", () => setMode("auto"));
manualModeBtn.addEventListener("click", () => setMode("manual"));

selectionStage.addEventListener("pointerdown", (event) => {
  if (currentMode !== "manual" || !originalDataUrl) return;
  event.preventDefault();
  resetResult();
  dragStart = getStagePoint(event);
  selectionStage.setPointerCapture(event.pointerId);
  updateSelection(dragStart, dragStart);
});

selectionStage.addEventListener("pointermove", (event) => {
  if (!dragStart || currentMode !== "manual") return;
  event.preventDefault();
  updateSelection(dragStart, getStagePoint(event));
});

selectionStage.addEventListener("pointerup", (event) => {
  if (!dragStart || currentMode !== "manual") return;
  event.preventDefault();
  updateSelection(dragStart, getStagePoint(event));
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
