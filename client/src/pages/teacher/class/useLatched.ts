import { useState } from 'react';

/**
 * Keeps showing the last non-null value after `value` becomes null, so a modal driven by `opened={value !== null}`
 * keeps its content during the close transition instead of flashing empty.
 */
export function useLatched<T>(value: T | null): T | null {
  const [latched, setLatched] = useState<T | null>(value);
  if (value !== null && value !== latched) setLatched(value);
  return value ?? latched;
}
