import { useEffect, useState } from 'react';
import { numOrNull } from '../strategy';

interface Props {
  value: number | null;
  onChange: (v: number | null) => void;
  className?: string;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
}

/**
 * A number input that keeps what is being typed. A plain controlled number input cannot hold a half-typed "-" or "1.":
 * the browser reports an empty value and React would wipe it. This keeps the text locally and only reports real numbers.
 */
export function NumField({ value, onChange, className, min, max, step, label }: Props) {
  const [text, setText] = useState(value === null ? '' : String(value));
  useEffect(() => {
    if (numOrNull(text) !== value) setText(value === null ? '' : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follow the outside value only, not our own typing
  }, [value]);
  return (
    <input
      type="number"
      className={className}
      value={text}
      min={min}
      max={max}
      step={step}
      aria-label={label}
      onChange={e => { setText(e.target.value); onChange(numOrNull(e.target.value)); }}
    />
  );
}
