// OCR via tesseract.js (WASM — no native binary needed).
// Optional: sharp preprocessing (upscale+grayscale) when installed.
import { createWorker } from "tesseract.js";

let workerPromise = null;
let sharp = null;
try {
  sharp = (await import("sharp")).default;
} catch {
  // sharp is optional; tesseract.js handles raw buffers too
}

async function getWorker() {
  workerPromise ??= createWorker("eng");
  return workerPromise;
}

export async function imageBufferToText(buf) {
  let input = buf;
  if (sharp) {
    input = await sharp(buf)
      .greyscale()
      .resize({ width: 1600, withoutEnlargement: false })
      .normalise()
      .png()
      .toBuffer();
  }
  const worker = await getWorker();
  const { data } = await worker.recognize(input);
  return data.text || "";
}
