import { describe, expect, it } from 'vitest';
import { formatCurrency, getIncomeColor, getIncomeHeight, INCOME_STOPS, MISSING_COLOR } from '../src/lib/income';

describe('shared income encoding', () => {
  it('keeps missing values distinct from zero', () => {
    expect(formatCurrency(null)).toBe('Not available');
    expect(formatCurrency(0)).toBe('$0');
    expect(getIncomeColor(null)).toBe(MISSING_COLOR);
    expect(getIncomeColor(0)).not.toBe(MISSING_COLOR);
  });
  it('matches every legend stop and clamps the color range', () => {
    for (const stop of INCOME_STOPS) expect(getIncomeColor(stop.value)).toBe(stop.color);
    expect(getIncomeColor(0)).toBe(INCOME_STOPS[0].color);
    expect(getIncomeColor(300000)).toBe(INCOME_STOPS[4].color);
  });
  it('encodes positive income with proportional extrusion heights', () => {
    expect(getIncomeHeight(100000)).toBe(getIncomeHeight(50000) * 2);
    expect(getIncomeHeight(null)).toBeGreaterThan(0);
  });
});
