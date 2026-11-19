/**
 * 图片缩放工具：用 Canvas 对 base64 图片进行高质量等比缩放，
 * 确保插入 HTML 后的图片不超过容器宽度且清晰不失真。
 */

export interface ResizeResult {
  dataUrl: string;
  originalDataUrl: string; // 原始图片 base64，未缩放版本，供灯箱点击放大查看
  resized: boolean;
  originalWidth: number;
  originalHeight: number;
  newWidth: number;
  newHeight: number;
}

/**
 * 用 Canvas 对 base64 data URL 图片进行高质量等比缩放。
 *
 * - 若图片宽度 ≤ maxWidth，直接返回原始 dataUrl，不缩放（避免放大模糊）
 * - 若图片宽度 > maxWidth，等比缩放到 maxWidth
 * - SVG 图片不缩放（矢量图可任意缩放）
 * - 使用 imageSmoothingQuality="high" 保证下采样清晰度
 * - 导出时保持原格式（JPEG/PNG/WebP），quality 0.92
 *
 * @param dataUrl - 图片的 base64 data URL
 * @param maxWidth - 目标最大宽度（像素）
 * @returns 缩放后的 data URL 及缩放元信息
 */
export function resizeImage(
  dataUrl: string,
  maxWidth: number
): Promise<ResizeResult> {
  return new Promise((resolve, reject) => {
    // 防御：无效输入
    if (!dataUrl || !dataUrl.startsWith("data:image/")) {
      reject(new Error("resizeImage: 无效的 data URL：" + String(dataUrl).slice(0, 60)));
      return;
    }

    // SVG 不进行栅格化缩放
    if (dataUrl.includes("image/svg+xml")) {
      const img = new Image();
      img.onload = () =>
        resolve({
          dataUrl,
          originalDataUrl: dataUrl,
          resized: false,
          originalWidth: img.naturalWidth || 0,
          originalHeight: img.naturalHeight || 0,
          newWidth: img.naturalWidth || 0,
          newHeight: img.naturalHeight || 0,
        });
      img.onerror = () =>
        resolve({
          dataUrl,
          originalDataUrl: dataUrl,
          resized: false,
          originalWidth: 0,
          originalHeight: 0,
          newWidth: 0,
          newHeight: 0,
        });
      img.src = dataUrl;
      return;
    }

    const img = new Image();

    img.onload = () => {
      const origW = img.naturalWidth;
      const origH = img.naturalHeight;

      // 无效尺寸
      if (origW <= 0 || origH <= 0) {
        reject(new Error(`resizeImage: 图片尺寸无效 (${origW}x${origH})`));
        return;
      }

      // 不需要缩放
      if (origW <= maxWidth || maxWidth <= 0) {
        resolve({
          dataUrl,
          originalDataUrl: dataUrl,
          resized: false,
          originalWidth: origW,
          originalHeight: origH,
          newWidth: origW,
          newHeight: origH,
        });
        return;
      }

      // Canvas 高质量缩放
      const scale = maxWidth / origW;
      const newW = Math.round(maxWidth);
      const newH = Math.round(origH * scale);

      const canvas = document.createElement("canvas");
      canvas.width = newW;
      canvas.height = newH;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        // Canvas 不可用，返回原图
        resolve({
          dataUrl,
          originalDataUrl: dataUrl,
          resized: false,
          originalWidth: origW,
          originalHeight: origH,
          newWidth: origW,
          newHeight: origH,
        });
        return;
      }

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, newW, newH);

      const mime = dataUrl.match(/^data:(image\/\w+);/)?.[1] || "image/png";
      const resizedDataUrl = canvas.toDataURL(mime, 0.92);

      resolve({
        dataUrl: resizedDataUrl,
        originalDataUrl: dataUrl,
        resized: true,
        originalWidth: origW,
        originalHeight: origH,
        newWidth: newW,
        newHeight: newH,
      });
    };

    img.onerror = () => {
      // 加载失败时返回原 dataUrl，不阻塞流程
      resolve({
        dataUrl,
        originalDataUrl: dataUrl,
        resized: false,
        originalWidth: 0,
        originalHeight: 0,
        newWidth: 0,
        newHeight: 0,
      });
    };

    img.src = dataUrl;
  });
}

/**
 * 从 iframe 的 contentDocument 中获取可用内容区宽度。
 * 返回 body.clientWidth 减去常见 padding（40px）。
 *
 * @param iframeDoc - iframe 的 contentDocument，若为 null 返回默认值
 * @returns 可用最大宽度（px）
 */
export function getIframeContentWidth(
  iframeDoc: Document | null | undefined
): number {
  if (!iframeDoc || !iframeDoc.body) return 800;
  const bodyW = iframeDoc.body.clientWidth;
  if (bodyW <= 0) return 800;
  return Math.max(400, bodyW - 40); // 预留 20px*2 padding，至少 400px
}
