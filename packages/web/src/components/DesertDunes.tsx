import React from 'react';

// Detailed SVG Camel Silhouette
export function CamelSilhouette({ className = '', style = {} }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg
      viewBox="0 0 72 54"
      fill="currentColor"
      className={`inline-block shrink-0 ${className}`}
      style={style}
      aria-label="Camel silhouette"
    >
      {/* Camel body & anatomy */}
      <path d="M 62 13 
               C 60 10, 56 8, 52 11 
               C 50 12, 47 16, 45 22 
               C 43 25, 41 27, 38 27
               C 36 22, 34 16, 29 16
               C 23 16, 21 23, 19 28
               C 16 28, 14 30, 12 34
               C 11 36, 9 37, 8 43
               L 8 49 L 10 49 L 11 44
               C 12 40, 13 38, 15 37
               L 16 48 L 18 48 L 19 39
               C 23 40, 27 40, 31 38
               L 32 49 L 34 49 L 35 41
               L 37 41 L 38 48 L 40 48
               C 42 41, 44 35, 47 34
               C 50 30, 52 23, 54 18
               C 56 16, 58 15, 61 16
               C 63 16, 64 15, 64 14
               Z" />
      {/* Pack saddle luggage on camel */}
      <path d="M 24 23 C 25 19, 31 19, 33 23 L 34 29 C 31 31, 26 31, 23 29 Z" opacity="0.9" />
      {/* Tail */}
      <path d="M 12 34 Q 8 36, 9 42" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  );
}

// Caravan string of 3 camels tethered together
export function Caravan({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-end gap-3 text-[#140E19] select-none ${className}`}>
      {/* Trailing pack camel */}
      <div className="relative">
        <CamelSilhouette className="w-9 h-7 text-[#201524]" />
        {/* Lead tether rope */}
        <div className="absolute top-3 -right-3 w-4 h-[1px] bg-[#C89B6B]/40 rotate-12" />
      </div>

      {/* Middle pack camel */}
      <div className="relative">
        <CamelSilhouette className="w-11 h-8 text-[#1A111E]" />
        {/* Lead tether rope */}
        <div className="absolute top-3 -right-3 w-4 h-[1px] bg-[#C89B6B]/50 rotate-12" />
      </div>

      {/* Lead caravan guide camel */}
      <div className="relative">
        <CamelSilhouette className="w-12 h-9 text-[#140D18]" />
      </div>
    </div>
  );
}

interface DesertDunesProps {
  interactive?: boolean;
  isProcessing?: boolean;
  className?: string;
  showCaravan?: boolean;
}

export function DesertDunes({
  interactive = false,
  isProcessing = false,
  className = '',
  showCaravan = true,
}: DesertDunesProps) {
  // Pre-calculated star coordinates to avoid client hydration drift
  const stars = [
    { x: 12, y: 15, size: 1.5, delay: 0 },
    { x: 28, y: 22, size: 1, delay: 1.2 },
    { x: 44, y: 10, size: 2, delay: 2.5 },
    { x: 58, y: 18, size: 1, delay: 0.8 },
    { x: 72, y: 12, size: 2.5, delay: 1.8 },
    { x: 84, y: 26, size: 1.5, delay: 3.1 },
    { x: 92, y: 14, size: 1, delay: 0.4 },
    { x: 20, y: 35, size: 1, delay: 2.0 },
    { x: 38, y: 28, size: 1.5, delay: 1.5 },
    { x: 65, y: 32, size: 2, delay: 2.8 },
    { x: 80, y: 38, size: 1, delay: 0.9 },
    { x: 50, y: 8, size: 1.5, delay: 1.1 },
  ];

  return (
    <div
      className={`absolute inset-0 pointer-events-none overflow-hidden select-none transition-opacity duration-700 ${className}`}
    >
      {/* Sky Background Gradient: #0A0B14 to #171833 */}
      <div 
        className="absolute inset-0"
        style={{
          background: 'radial-gradient(ellipse 90% 80% at 75% 20%, #1c1d3d 0%, #171833 40%, #0A0B14 85%)',
        }}
      />

      {/* Moon Glow & Moon Orb */}
      <div 
        className={`absolute top-10 right-[18%] w-56 h-56 rounded-full blur-3xl transition-all duration-1000 pointer-events-none ${
          isProcessing ? 'opacity-50 scale-110 animate-moon-aura' : 'opacity-30'
        }`}
        style={{ backgroundColor: 'var(--moon)' }}
      />
      <div 
        className={`absolute top-16 right-[24%] w-16 h-16 rounded-full border border-[#F0DFB4]/30 shadow-lg pointer-events-none transition-all duration-700 ${
          isProcessing ? 'shadow-[0_0_55px_rgba(240,223,180,0.65)] scale-105' : ''
        }`}
        style={{
          background: 'radial-gradient(circle at 35% 35%, #FBF6E5 0%, #F0DFB4 60%, #C89B6B 100%)',
          boxShadow: isProcessing
            ? '0 0 60px rgba(240, 223, 180, 0.7)'
            : '0 0 45px rgba(240, 223, 180, 0.35)',
        }}
      />

      {/* Star Field */}
      <div className="absolute inset-0">
        {stars.map((s, idx) => (
          <div
            key={idx}
            className={`absolute rounded-full bg-[#F0DFB4] ${
              isProcessing ? 'animate-pulse' : 'animate-twinkle'
            }`}
            style={{
              left: `${s.x}%`,
              top: `${s.y}%`,
              width: `${s.size}px`,
              height: `${s.size}px`,
              animationDelay: `${s.delay}s`,
              boxShadow: s.size > 1.5 ? '0 0 6px rgba(240, 223, 180, 0.8)' : 'none',
            }}
          />
        ))}
      </div>

      {/* Ambient Sand Drift Particles */}
      <div className="absolute inset-0 overflow-hidden">
        {[
          { top: '48%', left: '85%', delay: '0s', dur: '6s' },
          { top: '62%', left: '90%', delay: '2s', dur: '8s' },
          { top: '55%', left: '70%', delay: '4s', dur: '7s' },
          { top: '75%', left: '60%', delay: '1s', dur: '5.5s' },
        ].map((p, i) => (
          <div
            key={i}
            className="absolute w-28 h-[1px] bg-gradient-to-l from-transparent via-[#C89B6B]/40 to-transparent animate-sand-drift"
            style={{
              top: p.top,
              left: p.left,
              animationDelay: p.delay,
              animationDuration: p.dur,
            }}
          />
        ))}
      </div>

      {/* Ambient Moonlight Aura across the dune basin during AI processing */}
      {isProcessing && (
        <div
          className="absolute bottom-0 left-0 right-0 h-[50%] pointer-events-none animate-moon-aura transition-opacity duration-1000 z-10"
          style={{
            background:
              'radial-gradient(ellipse 80% 60% at 50% 85%, rgba(240, 223, 180, 0.18) 0%, rgba(240, 223, 180, 0.06) 55%, transparent 100%)',
          }}
        />
      )}

      {/* PARALLAX DUNE LAYER 1: Furthest silhouette (--dune-far #241C2E) */}
      <svg
        className={`absolute bottom-0 left-0 w-full h-[52%] preserve-3d transition-all duration-700 ${
          isProcessing ? 'animate-moon-pulse' : ''
        }`}
        viewBox="0 0 1440 380"
        preserveAspectRatio="none"
        fill="none"
      >
        <path
          d="M0,210 Q320,110 680,180 T1440,120 L1440,380 L0,380 Z"
          fill="#241C2E"
          opacity="0.95"
        />
        {/* Subtle moonlit ridge glow on far dune when AI is processing */}
        {isProcessing && (
          <path
            d="M0,210 Q320,110 680,180 T1440,120"
            stroke="var(--moon)"
            strokeWidth="1.8"
            className="animate-moon-ridge"
            fill="none"
          />
        )}
      </svg>

      {/* PARALLAX DUNE LAYER 2: Mid silhouette (--dune-mid #3A2B33) */}
      <svg
        className={`absolute bottom-0 left-0 w-full h-[44%] transition-all duration-700 ${
          isProcessing ? 'animate-moon-pulse' : ''
        }`}
        viewBox="0 0 1440 340"
        preserveAspectRatio="none"
        fill="none"
      >
        <path
          d="M0,240 Q460,80 940,170 T1440,140 L1440,340 L0,340 Z"
          fill="#3A2B33"
        />
        {/* Ridge rim highlight on mid dune - pulses gently with --moon during AI processing */}
        <path
          d="M0,240 Q460,80 940,170 T1440,140"
          stroke={isProcessing ? 'var(--moon)' : '#C89B6B'}
          strokeWidth={isProcessing ? '2' : '1'}
          strokeOpacity={isProcessing ? 0.9 : 0.18}
          className={isProcessing ? 'animate-moon-ridge' : ''}
          fill="none"
        />
      </svg>

      {/* PARALLAX DUNE LAYER 3 & RIDGE: Foreground silhouette (--dune-near #57392C) */}
      <svg
        className={`absolute bottom-0 left-0 w-full h-[34%] transition-all duration-700 ${
          isProcessing ? 'animate-moon-pulse' : ''
        }`}
        viewBox="0 0 1440 280"
        preserveAspectRatio="none"
        fill="none"
      >
        <path
          d="M0,260 Q380,130 820,140 T1440,90 L1440,280 L0,280 Z"
          fill="#57392C"
        />
        {/* Moonlit Ridge Highlight (--sand #C89B6B & --moon #F0DFB4) - glows and pulses with --moon */}
        <path
          d="M0,260 Q380,130 820,140 T1440,90"
          stroke={isProcessing ? 'var(--moon)' : '#C89B6B'}
          strokeWidth={isProcessing ? '3' : '2.5'}
          strokeOpacity={isProcessing ? 1 : 0.85}
          strokeLinecap="round"
          className={isProcessing ? 'animate-moon-ridge' : ''}
          fill="none"
        />
        {/* Secondary soft moonlight glow along the crest */}
        <path
          d="M320,175 Q600,132 820,140 T1300,102"
          stroke="var(--moon)"
          strokeWidth={isProcessing ? '2.2' : '1.2'}
          strokeOpacity={isProcessing ? 0.95 : 0.6}
          strokeLinecap="round"
          className={isProcessing ? 'animate-moon-ridge' : ''}
          fill="none"
        />
      </svg>

      {/* CARAVAN CROSSING THE MOONLIT RIDGE */}
      {/* Positioned on the right-weighted dune horizon crest */}
      {showCaravan && (
        <div 
          className="absolute w-[620px] pointer-events-none"
          style={{
            bottom: '22%',
            right: '8%',
          }}
        >
          <div className="w-full flex justify-end animate-caravan">
            <Caravan />
          </div>
        </div>
      )}
    </div>
  );
}
