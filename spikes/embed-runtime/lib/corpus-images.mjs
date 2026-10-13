// 測試圖片清單（中繼資料）。實際像素檔由 scripts/make-assets.mjs 產生到 .tmp/assets/。
// cats.jpg 來自公開測試資料集（Hugging Face transformers.js-docs），其餘 5 張為本 spike 自行合成的 SVG。
// 描述文字（en / zh）皆為本 spike 自寫，用於檢索探測（Q4、Q5）。

export const CATS_URL =
  "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/cats.jpg";

/** kind: "download" 表示從公開網址取得；"svg" 表示由 assets/<name>.svg 轉檔。 */
export const IMAGES = [
  {
    id: "cats",
    kind: "download",
    url: CATS_URL,
    file: "cats.jpg",
    descEn: "two cats sleeping together on a couch",
    descZh: "兩隻貓一起在沙發上睡覺",
  },
  {
    id: "red_circle",
    kind: "svg",
    svg: "red-circle.svg",
    file: "red_circle.png",
    descEn: "a solid red circle centered on a plain white background",
    descZh: "純白背景正中央的一個紅色實心圓形",
  },
  {
    id: "blue_square",
    kind: "svg",
    svg: "blue-square.svg",
    file: "blue_square.png",
    descEn: "a solid blue square on a plain white background",
    descZh: "純白背景上的一個藍色實心正方形",
  },
  {
    id: "green_triangle",
    kind: "svg",
    svg: "green-triangle.svg",
    file: "green_triangle.png",
    descEn: "a solid green triangle pointing upwards on a white background",
    descZh: "白色背景上的一個綠色實心三角形，尖端朝上",
  },
  {
    id: "text_hello",
    kind: "svg",
    svg: "text-hello.svg",
    file: "text_hello.png",
    descEn: "a white image with the black text Hello 你好 written in the middle",
    descZh: "白底圖片，正中間寫著黑色文字 Hello 你好",
  },
  {
    id: "bar_chart",
    kind: "svg",
    svg: "bar-chart.svg",
    file: "bar_chart.png",
    descEn: "a simple bar chart with five bars whose heights increase from left to right",
    descZh: "一個簡單的長條圖，五根長條由左到右越來越高",
  },
];
