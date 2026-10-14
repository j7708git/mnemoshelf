/**
 * 系統匣圖示：以 base64 內嵌的 32×32 PNG 產生 `nativeImage`。
 *
 * 為什麼內嵌而不是放檔案：這樣 `--dir`／未打包（`electron .`）兩種模式看到同一份圖示，
 * 也不必處理 asar 內的路徑（Tray 需要真實檔案路徑時的常見坑）。圖示是程式產生的
 * （圓角方塊＋三條橫槓，代表「記憶堆疊」的意象），沒有外部來源與授權問題。
 *
 * macOS 另外提供單色（黑＋透明）版本並標成 template image：macOS 的系統匣會依主題自動反白，
 * 彩色圖示在那裡會顯示成固定的黑塊。**macOS 未實測**（本卡只能測 Linux）。
 */
import { nativeImage, type NativeImage } from "electron";

/** 彩色圖示（Linux／Windows 用）：深藍圓角方塊＋白色橫槓。 */
const COLORED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAX0lEQVR42mNgGAVDBagaB/0nBQ+IpVR1DLUsJ8sR1LacJEfQynKiHTGyHYBNA6WAJEeMOoDW8T80HTCaBkYT4WgipKsDsDmC2g4YrY4Hf5NsUDRKB0WzfFB0TEYBPQAANu8zFKMkYgkAAAAASUVORK5CYII";

/** 單色圖示（macOS template image 用）：黑＋透明。 */
const TEMPLATE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAUUlEQVR42u2XUQoAMAhCu/+l6wxBpcET/PbBHHMR6JGyaUnoKEwOWxregshlA9AO37hJAMjO/ycAHaCElPAUIA4AeI79J5nFKLWY5RYfE7SuAoaUxkj9feWxAAAAAElFTkSuQmCC";

export interface TrayImageOptions {
  platform: NodeJS.Platform;
}

/** 建立系統匣用的圖示（macOS 會另外標成 template image）。 */
export function createTrayImage(options: TrayImageOptions): NativeImage {
  const isMac = options.platform === "darwin";
  const image = nativeImage.createFromBuffer(Buffer.from(isMac ? TEMPLATE_PNG_BASE64 : COLORED_PNG_BASE64, "base64"));
  if (isMac && typeof image.setTemplateImage === "function") {
    image.setTemplateImage(true);
  }
  return image;
}
