import { parseAtomicAmount } from './primitives';

function checkedDecimals(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) throw new Error('Invalid asset decimals');
  return value;
}

/** Decimals must come from admitted metadata, not an untrusted token response.
 * Comma is accepted as a decimal separator, never as a thousands separator.
 * No trimming, exponent notation, floating point, rounding or precision loss.
 */
export function decimalToAtomic(value: unknown, decimals: number): string {
  const precision = checkedDecimals(decimals);
  if (typeof value !== 'string' || value.length > 335 || !/^(?:0|[1-9][0-9]*)(?:[.,][0-9]+)?$(?![\s\S])/.test(value)) {
    throw new Error('Invalid decimal amount');
  }
  const [whole, fraction = ''] = value.replace(',', '.').split('.');
  if (fraction.length > precision) throw new Error('Amount exceeds asset precision');
  return parseAtomicAmount((whole + fraction.padEnd(precision, '0')).replace(/^0+(?=[0-9])/, ''));
}

/** Exact, ungrouped display: formatting never hides spendable dust. */
export function atomicToDecimal(value: unknown, decimals: number): string {
  const precision = checkedDecimals(decimals);
  const atomic = parseAtomicAmount(value);
  if (precision === 0) return atomic;
  const padded = atomic.padStart(precision + 1, '0');
  const fraction = padded.slice(-precision).replace(/0+$/, '');
  return `${padded.slice(0, -precision)}${fraction ? `.${fraction}` : ''}`;
}
