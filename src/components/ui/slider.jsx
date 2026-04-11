import React from 'react';

export const Slider = React.forwardRef(({ className = '', min = 0, max = 100, value = 50, onChange, step = 1, ...props }, ref) => {
  return (
    <input
      ref={ref}
      type="range"
      min={min}
      max={max}
      value={value}
      step={step}
      onChange={(e) => onChange && onChange([Number(e.target.value)])}
      className={`w-full h-2 bg-gray-200 rounded appearance-none cursor-pointer accent-blue-600 ${className}`}
      {...props}
    />
  );
});

Slider.displayName = 'Slider';
