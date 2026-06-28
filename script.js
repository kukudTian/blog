const text = {
  processing: "处理中...",
  processAuto: "去除水印",
  processManual: "去除定位水印",
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

function getDisplayedWatermarkSize() {
  if (!originalImage.naturalWidth || !originalImage.naturalHeight) return 48;

  const rect = originalImage.getBoundingClientRect();
  const config = getWatermarkConfig(originalImage.naturalWidth, originalImage.naturalHeight);
  const scale = Math.min(rect.width / originalImage.naturalWidth, rect.height / originalImage.naturalHeight);
  return Math.max(12, config.logoSize * scale);
}

function updateFixedSelection(centerPoint) {
  const size = getDisplayedWatermarkSize();
  const rect = selectionStage.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width - size, centerPoint.x - size / 2));
  const y = Math.max(0, Math.min(rect.height - size, centerPoint.y - size / 2));
  selection = { x, y, width: size, height: size };
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
      area = forceFixedWatermarkArea(imageData, area, config.logoSize);
    } else {
      config = getWatermarkConfig(image.width, image.height);
      area = getWatermarkArea(image.width, image.height, config);
    }

    const alphaMap = watermarkRemover.getAlphaMap(config.logoSize);
    removeWatermarkPixels(imageData, alphaMap, config.logoSize, area, {
      alphaThreshold: 0.002,
      strength: 1
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
  dragStart = true;
  selectionStage.setPointerCapture(event.pointerId);
  updateFixedSelection(getStagePoint(event));
});

selectionStage.addEventListener("pointermove", (event) => {
  if (!dragStart || currentMode !== "manual") return;
  event.preventDefault();
  updateFixedSelection(getStagePoint(event));
});

selectionStage.addEventListener("pointerup", (event) => {
  if (!dragStart || currentMode !== "manual") return;
  event.preventDefault();
  updateFixedSelection(getStagePoint(event));
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
