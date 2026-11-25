'use strict';

// 托盘图标：把角色立绘裁成圆形头像用的 32×32 图，并生成「头像 + 红点」的提醒态。
// 主进程 / Electron 专用（依赖 nativeImage）；不放渲染进程。

const { nativeImage } = require('electron');

/** 取立绘上方正方形（头 / 上半身）再缩到 32×32，比整张全身图清楚。 */
function avatarFromPath(framePath) {
  if (typeof framePath !== 'string' || framePath === '') return null;
  let image;
  try {
    image = nativeImage.createFromPath(framePath);
  } catch {
    return null;
  }
  if (!image || image.isEmpty()) return null;
  const size = image.getSize();
  if (!size.width || !size.height) return null;
  const side = Math.min(size.width, size.height);
  const crop = side < size.width || side < size.height
    ? image.crop({
      x: Math.floor((size.width - side) / 2),
      y: 0,
      width: side,
      height: side,
    })
    : image;
  return crop.resize({ width: 32, height: 32, quality: 'best' });
}

/** 在头像右下角画一个红点（BGRA 原地写入），闪烁时红点出现 / 消失。 */
function withBadge(image) {
  if (!image || image.isEmpty()) return image;
  const size = image.getSize();
  if (!size.width || !size.height) return image;
  let bitmap;
  try {
    bitmap = image.toBitmap();
  } catch {
    return image;
  }
  const radius = Math.max(3, Math.round(Math.min(size.width, size.height) * 0.2));
  const border = radius + 1;
  const cx = size.width - radius - 1;
  const cy = size.height - radius - 1;
  for (let y = Math.max(0, cy - border); y < Math.min(size.height, cy + border + 1); y += 1) {
    for (let x = Math.max(0, cx - border); x < Math.min(size.width, cx + border + 1); x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const distance = dx * dx + dy * dy;
      if (distance > border * border) continue;
      const offset = (y * size.width + x) * 4;
      if (distance <= radius * radius) {
        bitmap[offset] = 36;       // B
        bitmap[offset + 1] = 38;   // G
        bitmap[offset + 2] = 232;  // R
        bitmap[offset + 3] = 255;  // A
      } else {
        bitmap[offset] = 255;
        bitmap[offset + 1] = 255;
        bitmap[offset + 2] = 255;
        bitmap[offset + 3] = 255;
      }
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width: size.width, height: size.height });
}

module.exports = {
  avatarFromPath,
  withBadge,
};
