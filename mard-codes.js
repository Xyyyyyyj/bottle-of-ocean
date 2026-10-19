/** MARD / 2.6mm 拼豆合法色号。OCR 结果必须落在此表才写入矩阵。 */
function series(prefix, max) {
  const out = [];
  for (let i = 1; i <= max; i++) out.push(`${prefix}${i}`);
  return out;
}

export const LEGAL_CODES = new Set([
  ...series("A", 26),
  ...series("B", 32),
  ...series("C", 31),
  ...series("D", 27),
  ...series("E", 26),
  ...series("F", 24),
  ...series("G", 24),
  ...series("H", 23),
  ...series("M", 24),
  ...series("P", 24),
  ...series("Q", 24),
  ...series("R", 24),
  ...series("T", 24),
  ...series("Y", 24),
  ...series("ZG", 20),
]);

/** 白/透明：写入矩阵但不点亮。 */
export const UNLIT_CODES = new Set(["H1", "H2"]);

/** A01 / H02 → A1 / H2，兼容 Pindo 图纸上的补零色号。 */
export function canonicalCode(code) {
  const raw = String(code || "").toUpperCase();
  const match = raw.match(/^([A-Z]+)0*([1-9]\d*)$/);
  return match ? `${match[1]}${match[2]}` : raw;
}

export function isLegalCode(code) {
  return LEGAL_CODES.has(canonicalCode(code));
}

export function isUnlitCode(code) {
  return UNLIT_CODES.has(canonicalCode(code));
}

const CONFUSIONS = [
  ["O", "0"],
  ["0", "O"],
  ["I", "1"],
  ["L", "1"],
  ["Z", "2"],
  ["S", "5"],
  ["G", "6"],
  ["B", "8"],
];

export function normalizeOcrText(text) {
  return String(text || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/** OCR 原文 → 合法色号。先精确匹配，再试常见形近字。 */
export function validateColorCode(text) {
  const raw = normalizeOcrText(text);
  if (!raw) return null;
  const hit = canonicalCode(raw);
  if (LEGAL_CODES.has(hit)) return hit;

  const queue = [raw];
  const seen = new Set(queue);
  for (const cur of queue) {
    for (const [from, to] of CONFUSIONS) {
      if (!cur.includes(from)) continue;
      const next = cur.replace(from, to);
      if (seen.has(next)) continue;
      const canon = canonicalCode(next);
      if (LEGAL_CODES.has(canon)) return canon;
      seen.add(next);
      if (queue.length < 24) queue.push(next);
    }
  }
  return null;
}
