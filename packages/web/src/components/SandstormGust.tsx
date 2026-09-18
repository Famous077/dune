import React, { useEffect } from 'react';

interface SandstormGustProps {
  isActive: boolean;
  onComplete?: () => void;
}

export function SandstormGust({ isActive, onComplete }: SandstormGustProps) {
  useEffect(() => {
    if (isActive) {
      const timer = setTimeout(() => {
        onComplete?.();
      }, 1400);
      return () => clearTimeout(timer);
    }
  }, [isActive, onComplete]);

  if (!isActive) return null;

  return (
    <div 
      className="fixed inset-0 pointer-events-none z-50 overflow-hidden"
      aria-hidden="true"
    >
      {/* Primary sweeping dust wave */}
      <div 
        className="absolute inset-0 animate-sandstorm-gust"
        style={{
          background: 'linear-gradient(90deg, transparent 0%, rgba(58, 43, 51, 0.4) 15%, rgba(200, 155, 107, 0.75) 45%, rgba(87, 57, 44, 0.85) 60%, rgba(200, 155, 107, 0.5) 85%, transparent 100%)',
          backdropFilter: 'blur(3px)',
        }}
      />

      {/* Swirling sand grain streaks */}
      <div className="absolute inset-0 animate-sandstorm-gust opacity-80">
        {[
          { top: '15%', height: '2px', delay: '0.05s', opacity: 0.9 },
          { top: '28%', height: '3px', delay: '0.12s', opacity: 0.8 },
          { top: '42%', height: '1.5px', delay: '0.02s', opacity: 0.95 },
          { top: '56%', height: '2.5px', delay: '0.18s', opacity: 0.85 },
          { top: '70%', height: '2px', delay: '0.08s', opacity: 0.9 },
          { top: '84%', height: '3px', delay: '0.15s', opacity: 0.75 },
        ].map((line, idx) => (
          <div
            key={idx}
            className="absolute w-[140%] -left-[20%]"
            style={{
              top: line.top,
              height: line.height,
              background: 'linear-gradient(90deg, transparent, #C89B6B 30%, #F0DFB4 50%, #57392C 70%, transparent)',
              opacity: line.opacity,
            }}
          />
        ))}
      </div>

      {/* Dense sand particles */}
      <div className="absolute inset-0 animate-sandstorm-gust mix-blend-screen opacity-60">
        <svg className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
          <filter id="sand-noise">
            <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch" />
            <feColorMatrix type="matrix" values="0.78 0 0 0 0.78   0 0.6 0 0 0.6   0 0 0.42 0 0.42   0 0 0 1 0" />
          </filter>
          <rect width="100%" height="100%" filter="url(#sand-noise)" opacity="0.35" />
        </svg>
      </div>
    </div>
  );
}
