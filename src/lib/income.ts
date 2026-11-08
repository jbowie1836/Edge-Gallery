export const INCOME_STOPS = [
  { value: 40000, color: '#e4e7b4' },
  { value: 80000, color: '#b8d2a9' },
  { value: 120000, color: '#79b396' },
  { value: 160000, color: '#3a8a73' },
  { value: 200000, color: '#175547' },
] as const;

export const MISSING_COLOR = '#a9b3b5';

export function formatCurrency(value: number | null): string {
  return value === null ? 'Not available' : new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(value);
}

export function getIncomeColor(value: number | null): string {
  if (value === null) return MISSING_COLOR;
  const position = Math.max(0, Math.min(4, (value - 40000) / 40000));
  const index = Math.min(3, Math.floor(position));
  const ratio = position - index;
  const left = INCOME_STOPS[index].color;
  const right = INCOME_STOPS[index + 1].color;
  const channels = [1, 3, 5].map((offset) => {
    const a = parseInt(left.slice(offset, offset + 2), 16);
    const b = parseInt(right.slice(offset, offset + 2), 16);
    return Math.round(a + (b - a) * ratio).toString(16).padStart(2, '0');
  });
  return `#${channels.join('')}`;
}

export function getIncomeHeight(value: number | null): number {
  // A hairline base keeps zero and missing counties visible without implying income.
  return value === null ? 0.025 : Math.max(0.025, value / 50000);
}
