/**
 * 势力显示色：原始 config 颜色只作"身份"，显示时统一提亮/提饱和。
 * 秦的黑、韓的深灰绿在深色地图上几乎分不开，所以显示色不改配置、不改存档哈希，
 * 只在客户端做对比度校正；地图、势力表、棋子描边共用同一函数。
 */

const FALLBACK = [
  '#df6b6b', '#5a9bef', '#e0c05a', '#5ecf8b',
  '#b48bea', '#e89a55', '#55c7c0', '#d7dce3',
];

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function isHex(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

function rgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

function rgbToHsl({ r, g, b }) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h * 60, s, l };
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (n) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 只做显示层校正：不改 config，也不改 contentHash */
export function displayFactionColor(rawColor, factionId = '') {
  const raw = isHex(rawColor) ? rawColor : FALLBACK[hash(factionId) % FALLBACK.length];
  // 秦以黑为德；黑在深色沙盘上无法辨认，显示为高对比银灰，仍保留"素色"辨识
  if (factionId === 'qin') return '#d7dee8';
  const hsl = rgbToHsl(rgb(raw));
  if (hsl.s < 0.18 || hsl.l < 0.24) {
    return FALLBACK[hash(factionId) % FALLBACK.length];
  }
  const h = hsl.h;
  const s = clamp(hsl.s, 0.6, 0.9);
  const l = clamp(hsl.l, 0.54, 0.68);
  return hslToHex(h, s, l);
}

/** 用于势力名/边界的更亮一档；输入必须是 #rrggbb */
export function lightenFactionColor(rawColor, amount = 0.25) {
  const base = isHex(rawColor) ? rawColor : FALLBACK[0];
  const hsl = rgbToHsl(rgb(base));
  return hslToHex(hsl.h, clamp(hsl.s, 0.6, 0.9), clamp(hsl.l + amount, 0.6, 0.82));
}

export { FALLBACK as FACTION_DISPLAY_FALLBACK, hexToRgb };

function hexToRgb(hex) {
  return rgb(hex);
}
