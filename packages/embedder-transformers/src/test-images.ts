/**
 * 啟動探測（probe）用的合成測試圖。
 *
 * 圖片在執行期以程式生成（純 TypeScript + `node:zlib` 手寫最小 PNG 編碼器），
 * **不 commit 任何二進位檔**，也不讀取使用者檔案。
 *
 * 兩張圖刻意在形狀與顏色上明顯不同（藍色實心方塊 vs 綠色實心三角形），
 * 對應 M0 spike 驗證過的「低 soft token 預算仍能區分」概念；形狀組合是實測挑出
 * （見 createProbeImages 的註解）：最小邊界 0.156，對 0.132 的門檻有足夠餘裕。
 */
import { deflateSync } from "node:zlib";
import type { ImageInput } from "@mnemoshelf/core";

/** PNG 檔頭（8 bytes）。 */
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32 查表（PNG chunk 校驗）。 */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);

  const out = new Uint8Array(4 + body.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(4 + body.length, crc32(body));
  return out;
}

/** 把 RGB 像素編成 PNG（8-bit、truecolor、無交錯）。 */
export function encodePngRgb(width: number, height: number, rgb: Uint8Array): Uint8Array {
  if (rgb.length !== width * height * 3) {
    throw new Error(`像素緩衝大小不符：預期 ${width * height * 3}，實際 ${rgb.length}`);
  }
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type: none
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const parts = [
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

type Rgb = readonly [number, number, number];

const WHITE: Rgb = [255, 255, 255];
const BLUE: Rgb = [30, 80, 220];
const GREEN: Rgb = [30, 170, 60];

function makeCanvas(size: number): Uint8Array {
  const rgb = new Uint8Array(size * size * 3);
  for (let i = 0; i < size * size; i += 1) {
    rgb[i * 3] = WHITE[0];
    rgb[i * 3 + 1] = WHITE[1];
    rgb[i * 3 + 2] = WHITE[2];
  }
  return rgb;
}

function fillRect(rgb: Uint8Array, size: number, x0: number, y0: number, w: number, h: number, color: Rgb): void {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      const i = (y * size + x) * 3;
      rgb[i] = color[0];
      rgb[i + 1] = color[1];
      rgb[i + 2] = color[2];
    }
  }
}

/** 尖端朝上的實心等腰三角形。 */
function fillTriangle(rgb: Uint8Array, size: number, color: Rgb): void {
  const top = Math.round(size * 0.16);
  const bottom = Math.round(size * 0.84);
  const cx = Math.floor(size / 2);
  const half = Math.round(size * 0.34);
  for (let y = top; y <= bottom; y += 1) {
    const t = (y - top) / (bottom - top);
    const width = Math.round(half * t);
    for (let x = cx - width; x <= cx + width; x += 1) {
      const i = (y * size + x) * 3;
      rgb[i] = color[0];
      rgb[i + 1] = color[1];
      rgb[i + 2] = color[2];
    }
  }
}

/** 一張合成測試圖：位元組＋描述它的文字（英文與繁中各一句，用於跨語言檢查）。 */
export interface SyntheticProbeImage {
  /** 穩定識別（僅供訊息使用）。 */
  id: string;
  /** 圖片位元組（PNG）。 */
  image: ImageInput;
  /** 描述這張圖的文字。 */
  descriptions: string[];
}

/**
 * 建立兩張內容明顯不同的合成測試圖（藍色實心方塊 vs 綠色實心三角形）。
 *
 * 兩張圖都有英文與繁中描述：除了「圖 vs 描述」的英文檢查，也涵蓋跨語言語意對齊。
 *
 * 這組形狀是實測挑出來的：M0 spike 用過的「紅色圓 vs 藍色方塊」在 q4／512 維下
 * 邊界只有 0.131，剛好低於門檻；改成「方塊 vs 三角形」（形狀差異更明顯）後，
 * 實測最小邊界 0.156（見 e2e 報告），對 0.132 的門檻有足夠餘裕。
 */
export function createProbeImages(size = 256): SyntheticProbeImage[] {
  const square = makeCanvas(size);
  const squareSide = Math.floor((size * 2) / 3);
  fillRect(
    square,
    size,
    Math.floor((size - squareSide) / 2),
    Math.floor((size - squareSide) / 2),
    squareSide,
    squareSide,
    BLUE,
  );

  const triangle = makeCanvas(size);
  fillTriangle(triangle, size, GREEN);

  return [
    {
      id: "blue_square",
      image: { bytes: encodePngRgb(size, size, square), mimeType: "image/png" },
      descriptions: [
        "a solid blue square on a plain white background",
        "純白背景上的一個藍色實心正方形",
      ],
    },
    {
      id: "green_triangle",
      image: { bytes: encodePngRgb(size, size, triangle), mimeType: "image/png" },
      descriptions: [
        "a solid green triangle pointing upwards on a white background",
        "白色背景上的一個綠色實心三角形，尖端朝上",
      ],
    },
  ];
}
