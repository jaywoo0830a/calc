// ============================================================
// chargeConfig — 전하 배열 텍스트(x, y, q 줄 단위) ⇄ 목록 변환
// ⚙ Arrange 패널에서 사용. 순수 함수 (테스트 대상).
// ============================================================

export const MAX_Q = 4;
export const POS_LIMIT = 5.4;
export const MAX_CHARGES = 12;

export function chargesToLines(cs) {
  const fmt = (v) => (Math.round(v * 100) / 100).toString();
  return cs.map((c) => `${fmt(c.x)}, ${fmt(c.y)}, ${c.q}`).join('\n');
}

export function parseChargeLines(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error('Enter at least one line: x, y, q');
  if (lines.length > MAX_CHARGES) throw new Error(`Max ${MAX_CHARGES} charges`);
  const charges = [];
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(/[,\s]+/).filter(Boolean);
    if (parts.length < 2 || parts.length > 3) {
      throw new Error(`Line ${i + 1}: expected "x, y, q" (q optional, defaults to +1)`);
    }
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    const q = parts.length === 3 ? Number(parts[2]) : 1;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(q)) {
      throw new Error(`Line ${i + 1}: invalid number`);
    }
    if (Math.abs(x) > POS_LIMIT || Math.abs(y) > POS_LIMIT) {
      throw new Error(`Line ${i + 1}: positions must be within ±${POS_LIMIT}`);
    }
    if (q === 0) throw new Error(`Line ${i + 1}: q must be non-zero`);
    if (Math.abs(q) > MAX_Q) throw new Error(`Line ${i + 1}: |q| must be ≤ ${MAX_Q}`);
    charges.push({ id: `a${i}`, x, y, q });
  }
  return charges;
}
