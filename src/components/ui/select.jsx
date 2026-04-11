import React from 'react';

export const Select = ({ children, ...props }) => {
  return <div {...props}>{children}</div>;
};

export const SelectTrigger = React.forwardRef(({ className = '', children, ...props }, ref) => {
  return (
    <button
      ref={ref}
      className={`border border-gray-300 rounded px-3 py-2 w-full text-left focus:outline-none focus:ring-2 focus:ring-blue-500 flex justify-between items-center ${className}`}
      {...props}
    >
      {children}
    </button>
  );
});

SelectTrigger.displayName = 'SelectTrigger';

export const SelectValue = ({ placeholder = 'Select...' }) => {
  return <span>{placeholder}</span>;
};

export const SelectContent = React.forwardRef(({ className = '', children, ...props }, ref) => {
  return (
    <div
      ref={ref}
      className={`absolute mt-1 w-full border border-gray-300 rounded bg-white shadow-lg z-10 ${className}`}
      {...props}
    >
      {children}
    </div>
  );
});

SelectContent.displayName = 'SelectContent';

export const SelectItem = ({ children, ...props }) => {
  return (
    <div
      className="px-3 py-2 hover:bg-blue-100 cursor-pointer"
      {...props}
    >
      {children}
    </div>
  );
};
