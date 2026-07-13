const currentLanguage = document.documentElement.lang.toLowerCase().startsWith("en") ? "en" : "zh";
const translations = {
  zh: {
    loading: "引擎初始化中...",
    ready: "引擎已就绪，图片会在浏览器本地处理。",
    processing: "处理中...",
    completed: "已完成",
    pending: "等待中",
    error: "处理失败",
    noImages: "请先上传图片。",
    unsupported: "仅支持 PNG、JPG、WebP 图片。",
    tooLarge: "单张图片最大支持 20MB。",
    current: "新版",
    legacy: "旧版",
    watermark: "水印",
    reverse: "反向 Alpha",
    repair: "区域修复",
    confidence: "匹配度",
    download: "下载",
    loadFailed: "引擎加载失败，请刷新页面重试。"
  },
  en: {
    loading: "Engine is starting...",
    ready: "Engine ready. Images are processed locally in your browser.",
    processing: "Processing...",
    completed: "Completed",
    pending: "Waiting",
    error: "Failed",
    noImages: "Please upload images first.",
    unsupported: "Only PNG, JPG, and WebP images are supported.",
    tooLarge: "Each image can be up to 20MB.",
    current: "Current",
    legacy: "Legacy",
    watermark: "watermark",
    reverse: "reverse alpha",
    repair: "area repair",
    confidence: "confidence",
    download: "Download",
    loadFailed: "Engine failed to load. Please refresh the page and try again."
  }
};
const text = translations[currentLanguage];

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const acceptedTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

const dropArea = document.getElementById("drop-area");
const fileInput = document.getElementById("fileElem");
const engineStatus = document.getElementById("engineStatus");
const queuePanel = document.getElementById("queuePanel");
const queueList = document.getElementById("queueList");
const completedCount = document.getElementById("completedCount");
const totalCount = document.getElementById("totalCount");
const downloadAllBtn = document.getElementById("downloadAllBtn");
const clearAllBtn = document.getElementById("clearAllBtn");

let engine = null;
let queue = [];
let processingQueue = false;

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

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function captureImage(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is not available.");
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

function imageDataToAlphaMap(imageData) {
  const alphaMap = new Float32Array(imageData.width * imageData.height);
  const data = imageData.data;
  for (let index = 0; index < alphaMap.length; index += 1) {
    const offset = index * 4;
    alphaMap[index] = Math.max(data[offset], data[offset + 1], data[offset + 2]) / 255;
  }
  return alphaMap;
}

function isLargeImage(width, height) {
  return width > 1024 && height > 1024;
}

function getCurrentSmallMargin(width, height) {
  const longer = Math.max(width, height);
  const shorter = Math.min(width, height);
  const divisor = shorter >= 566 ? 2752 : shorter >= 550 ? 2816 : 2848;
  return Math.max(0, Math.round((longer / divisor) * 192));
}

function getWatermarkConfig(width, height, variant) {
  if (variant === "legacy") {
    return isLargeImage(width, height)
      ? { variant, logoSize: 96, marginRight: 64, marginBottom: 64 }
      : { variant, logoSize: 48, marginRight: 32, marginBottom: 32 };
  }

  if (isLargeImage(width, height)) {
    return { variant, logoSize: 96, marginRight: 192, marginBottom: 192 };
  }

  const margin = getCurrentSmallMargin(width, height);
  return { variant, logoSize: 36, marginRight: margin, marginBottom: margin };
}

function getWatermarkArea(width, height, config) {
  const size = config.logoSize;
  return {
    x: Math.max(0, width - config.marginRight - size),
    y: Math.max(0, height - config.marginBottom - size),
    width: Math.min(size, width),
    height: Math.min(size, height)
  };
}

function clampArea(area, imageData) {
  const x = Math.max(0, Math.min(imageData.width - 1, Math.round(area.x)));
  const y = Math.max(0, Math.min(imageData.height - 1, Math.round(area.y)));
  const width = Math.max(1, Math.min(imageData.width - x, Math.round(area.width)));
  const height = Math.max(1, Math.min(imageData.height - y, Math.round(area.height)));
  return { x, y, width, height };
}

class GeminiWatermarkEngine {
  constructor(captures) {
    this.captures = captures;
    this.alphaMaps = {};
  }

  static async create() {
    const [bg48, bg96, bgB36, bgB96] = await Promise.all([
      loadImage("assets/gemini-watermark-remover/bg_48.png"),
      loadImage("assets/gemini-watermark-remover/bg_96.png"),
      loadImage("assets/gemini-watermark-remover/bg_b_36.png"),
      loadImage("assets/gemini-watermark-remover/bg_b_96.png")
    ]);

    return new GeminiWatermarkEngine({
      legacy48: captureImage(bg48),
      legacy96: captureImage(bg96),
      current36: captureImage(bgB36),
      current96: captureImage(bgB96)
    });
  }

  hasCapture(variant, size) {
    if (variant === "current") return size === 36 || size === 96;
    return size === 48 || size === 96;
  }

  getCapture(variant, size) {
    const key = `${variant}${size}`;
    const capture = this.captures[key];
    if (!capture) throw new Error(`Missing watermark template: ${key}`);
    return capture;
  }

  getAlphaMap(variant, size) {
    const key = `${variant}:${size}`;
    if (!this.alphaMaps[key]) {
      this.alphaMaps[key] = imageDataToAlphaMap(this.getCapture(variant, size));
    }
    return this.alphaMaps[key];
  }

  getCandidates(width, height) {
    return ["current", "legacy"]
      .map((variant) => getWatermarkConfig(width, height, variant))
      .filter((config) => this.hasCapture(config.variant, config.logoSize))
      .map((config) => ({
        variant: config.variant,
        size: config.logoSize,
        config,
        position: getWatermarkArea(width, height, config),
        alphaMap: this.getAlphaMap(config.variant, config.logoSize),
        confidence: 0
      }));
  }

  scoreCandidate(imageData, alphaMap, area) {
    const position = clampArea(area, imageData);
    const { width, height } = position;
    const pixelCount = width * height;
    if (!pixelCount || alphaMap.length < pixelCount) return 0;

    let sampleCount = 0;
    let alphaSum = 0;
    let brightnessSum = 0;
    let alphaSquareSum = 0;
    let brightnessSquareSum = 0;
    let mixedSum = 0;

    for (let row = 0; row < height; row += 1) {
      for (let col = 0; col < width; col += 1) {
        const alpha = alphaMap[row * width + col];
        if (alpha < 0.01) continue;

        const offset = ((position.y + row) * imageData.width + position.x + col) * 4;
        const brightness = (imageData.data[offset] + imageData.data[offset + 1] + imageData.data[offset + 2]) / 765;

        sampleCount += 1;
        alphaSum += alpha;
        brightnessSum += brightness;
        alphaSquareSum += alpha * alpha;
        brightnessSquareSum += brightness * brightness;
        mixedSum += alpha * brightness;
      }
    }

    if (sampleCount < 16) return 0;

    const numerator = sampleCount * mixedSum - alphaSum * brightnessSum;
    const alphaVariance = sampleCount * alphaSquareSum - alphaSum * alphaSum;
    const brightnessVariance = sampleCount * brightnessSquareSum - brightnessSum * brightnessSum;

    if (alphaVariance <= 0 || brightnessVariance <= 0) return 0;
    return Math.max(0, numerator / Math.sqrt(alphaVariance * brightnessVariance));
  }

  detect(imageData) {
    const candidates = this.getCandidates(imageData.width, imageData.height);
    let best = candidates[0];

    candidates.forEach((candidate) => {
      candidate.confidence = this.scoreCandidate(imageData, candidate.alphaMap, candidate.position);
      if (!best || candidate.confidence > best.confidence) best = candidate;
    });

    return best;
  }

  removeReverseAlpha(imageData, candidate) {
    const data = imageData.data;
    const area = clampArea(candidate.position, imageData);
    const alphaMap = candidate.alphaMap;

    for (let row = 0; row < area.height; row += 1) {
      for (let col = 0; col < area.width; col += 1) {
        let alpha = alphaMap[row * area.width + col];
        if (alpha < 0.002) continue;

        alpha = Math.min(alpha, 0.99);
        const remaining = 1 - alpha;
        const offset = ((area.y + row) * imageData.width + area.x + col) * 4;

        for (let channel = 0; channel < 3; channel += 1) {
          const restored = (data[offset + channel] - 255 * alpha) / remaining;
          data[offset + channel] = Math.max(0, Math.min(255, Math.round(restored)));
        }
      }
    }
  }

  repairRect(imageData, area, radius = 10) {
    const target = clampArea(area, imageData);
    const mask = new Uint8Array(imageData.width * imageData.height);

    for (let y = target.y; y < target.y + target.height; y += 1) {
      for (let x = target.x; x < target.x + target.width; x += 1) {
        mask[y * imageData.width + x] = 1;
      }
    }

    const repaired = this.inpaint(imageData, mask, radius);
    imageData.data.set(repaired.data);
  }

  inpaint(imageData, mask, radius) {
    const { width, height, data } = imageData;
    const output = new Uint8ClampedArray(data);
    const distance = new Float32Array(width * height).fill(Infinity);
    const known = new Uint8Array(width * height);
    const queueItems = [];
    const directions = [[0, 1], [0, -1], [1, 0], [-1, 0]];

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (!mask[index]) {
          known[index] = 1;
          distance[index] = 0;
        }
      }
    }

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (!mask[index]) continue;

        for (const [dx, dy] of directions) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (!mask[ny * width + nx]) {
            distance[index] = 1;
            queueItems.push({ x, y, dist: 1 });
            break;
          }
        }
      }
    }

    queueItems.sort((a, b) => a.dist - b.dist);

    while (queueItems.length) {
      const current = queueItems.shift();
      const index = current.y * width + current.x;
      if (known[index]) continue;

      let totalWeight = 0;
      let red = 0;
      let green = 0;
      let blue = 0;

      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const nx = current.x + dx;
          const ny = current.y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

          const neighborIndex = ny * width + nx;
          if (!known[neighborIndex]) continue;

          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist <= 0 || dist > radius) continue;

          const weight = 1 / (dist * dist);
          const offset = neighborIndex * 4;
          red += output[offset] * weight;
          green += output[offset + 1] * weight;
          blue += output[offset + 2] * weight;
          totalWeight += weight;
        }
      }

      if (totalWeight > 0) {
        const offset = index * 4;
        output[offset] = red / totalWeight;
        output[offset + 1] = green / totalWeight;
        output[offset + 2] = blue / totalWeight;
        output[offset + 3] = 255;
      }

      known[index] = 1;

      for (const [dx, dy] of directions) {
        const nx = current.x + dx;
        const ny = current.y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

        const neighborIndex = ny * width + nx;
        if (mask[neighborIndex] && !known[neighborIndex] && distance[neighborIndex] === Infinity) {
          distance[neighborIndex] = distance[index] + 1;
          queueItems.push({ x: nx, y: ny, dist: distance[neighborIndex] });
          queueItems.sort((a, b) => a.dist - b.dist);
        }
      }
    }

    return new ImageData(output, width, height);
  }

  process(imageData) {
    const candidate = this.detect(imageData);
    if (candidate.confidence >= 0.08) {
      this.removeReverseAlpha(imageData, candidate);
      candidate.method = "reverse";
    } else {
      this.repairRect(imageData, candidate.position, 10);
      candidate.method = "repair";
    }
    return candidate;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderQueue() {
  queuePanel.classList.toggle("hidden", queue.length === 0);
  completedCount.textContent = queue.filter((item) => item.status === "completed").length;
  totalCount.textContent = queue.length;
  downloadAllBtn.disabled = !queue.some((item) => item.status === "completed");

  queueList.innerHTML = queue.map((item) => {
    const statusText = item.status === "completed"
      ? text.completed
      : item.status === "processing"
        ? text.processing
        : item.status === "error"
          ? text.error
          : text.pending;
    const preview = item.processedUrl || item.originalUrl || "";
    const detail = item.variant
      ? `${item.variant === "current" ? text.current : text.legacy} ${text.watermark} · ${item.method === "reverse" ? text.reverse : text.repair} · ${text.confidence} ${Math.round(item.confidence * 100)}%`
      : "";

    return `
      <article class="queue-card" data-id="${item.id}">
        <div class="queue-preview">
          ${preview ? `<img src="${preview}" alt="${escapeHtml(item.name)}">` : ""}
          ${item.status === "processing" ? `<div class="queue-overlay">${text.processing}</div>` : ""}
        </div>
        <div class="queue-card-body">
          <p class="queue-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</p>
          <div class="queue-meta">
            <span class="status-badge ${item.status}">${statusText}</span>
            ${detail ? `<span>${detail}</span>` : ""}
          </div>
          ${item.error ? `<p class="queue-error">${escapeHtml(item.error)}</p>` : ""}
          ${item.status === "completed" ? `<button type="button" class="btn btn-primary queue-download" data-download="${item.id}">${text.download}</button>` : ""}
        </div>
      </article>
    `;
  }).join("");
}

function addFiles(fileList) {
  if (!fileList || !fileList.length) return;

  const files = Array.from(fileList).filter((file) => {
    if (!acceptedTypes.has(file.type)) {
      alert(`${file.name}: ${text.unsupported}`);
      return false;
    }
    if (file.size > MAX_FILE_SIZE) {
      alert(`${file.name}: ${text.tooLarge}`);
      return false;
    }
    return true;
  });

  const items = files.map((file) => ({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    file,
    name: file.name,
    status: "pending",
    originalUrl: URL.createObjectURL(file),
    processedUrl: null,
    processedBlob: null,
    error: null,
    variant: null,
    confidence: 0,
    method: null
  }));

  queue = [...queue, ...items];
  renderQueue();
  processPendingItems();
}

async function processPendingItems() {
  if (processingQueue || !engine) return;
  processingQueue = true;

  while (queue.some((item) => item.status === "pending")) {
    const item = queue.find((entry) => entry.status === "pending");
    if (!item) break;
    item.status = "processing";
    renderQueue();

    try {
      const image = await loadImage(item.originalUrl);
      const imageData = captureImage(image);
      const candidate = engine.process(imageData);

      const canvas = document.createElement("canvas");
      canvas.width = imageData.width;
      canvas.height = imageData.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas is not available.");
      context.putImageData(imageData, 0, 0);

      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((result) => {
          if (result) resolve(result);
          else reject(new Error("Failed to create output image."));
        }, "image/png");
      });

      item.status = "completed";
      item.processedBlob = blob;
      item.processedUrl = URL.createObjectURL(blob);
      item.variant = candidate.variant;
      item.confidence = candidate.confidence;
      item.method = candidate.method;
    } catch (error) {
      item.status = "error";
      item.error = error instanceof Error ? error.message : String(error);
    }

    renderQueue();
  }

  processingQueue = false;
}

function getOutputName(name) {
  return `unwatermarked_${name.replace(/\.[^.]+$/, "")}.png`;
}

function downloadItem(item) {
  if (!item || !item.processedUrl) return;
  const link = document.createElement("a");
  link.href = item.processedUrl;
  link.download = getOutputName(item.name);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

async function downloadAll() {
  const completed = queue.filter((item) => item.status === "completed" && item.processedBlob);
  if (!completed.length) return;
  if (completed.length === 1) {
    downloadItem(completed[0]);
    return;
  }

  if (!window.JSZip) {
    completed.forEach(downloadItem);
    return;
  }

  const zip = new window.JSZip();
  completed.forEach((item) => {
    zip.file(getOutputName(item.name), item.processedBlob);
  });

  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `unwatermarked_${Date.now()}.zip`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function clearQueue() {
  queue.forEach((item) => {
    if (item.originalUrl) URL.revokeObjectURL(item.originalUrl);
    if (item.processedUrl) URL.revokeObjectURL(item.processedUrl);
  });
  queue = [];
  renderQueue();
  fileInput.value = "";
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
  addFiles(event.dataTransfer.files);
});

dropArea.addEventListener("paste", (event) => {
  addFiles(event.clipboardData.files);
});

fileInput.addEventListener("change", (event) => {
  addFiles(event.target.files);
});

queueList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-download]");
  if (!button) return;
  downloadItem(queue.find((item) => item.id === button.dataset.download));
});

downloadAllBtn.addEventListener("click", downloadAll);
clearAllBtn.addEventListener("click", clearQueue);

GeminiWatermarkEngine.create()
  .then((createdEngine) => {
    engine = createdEngine;
    engineStatus.textContent = text.ready;
    engineStatus.classList.add("ready");
    processPendingItems();
  })
  .catch((error) => {
    console.error(error);
    engineStatus.textContent = text.loadFailed;
    engineStatus.classList.add("error");
  });
