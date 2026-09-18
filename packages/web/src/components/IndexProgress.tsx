import {
  Check,
  Loader2,
  Circle,
  AlertTriangle,
  RefreshCw,
  ArrowLeft,
  Compass,
  ArrowRight,
  Sparkles,
  Layers,
  MapPin,
  X,
} from 'lucide-react';
import type { JobStage, JobStatus } from '@dune/shared/types';
import { CamelSilhouette } from './DesertDunes';

interface IndexProgressProps {
  job: JobStatus;
  /** "owner/repo", from the submitted URL until the meta exists. */
  repoName: string;
  /** Set when polling itself fails; the job may still be running. */
  pollError: string | null;
  isRetrying: boolean;
  /** Re-submits the repo the user asked for. */
  onRetry: () => void;
  onUseSample: () => void;
  onCancel: () => void;
  onComplete: () => void;
}

type PipelineStage = Exclude<JobStage, 'queued' | 'ready' | 'failed'>;

interface StageMetadata {
  id: PipelineStage;
  label: string;
  title: string;
  desc: string;
}

const STAGES_META: StageMetadata[] = [
  {
    id: 'cloning',
    label: 'CLONING',
    title: 'Worktree Unpacking',
    desc: 'Downloading the repository at its current commit',
  },
  {
    id: 'parsing',
    label: 'PARSING',
    title: 'Topographical Contouring',
    desc: 'Parsing TypeScript and JavaScript and mapping the import graph',
  },
  {
    id: 'embedding',
    label: 'EMBEDDING',
    title: 'Valley Crystallization',
    desc: 'Chunking the code and embedding it for search',
  },
  {
    id: 'finalising',
    label: 'FINALISING',
    title: 'Constellation Synthesis',
    desc: 'Storing the graph, routes and search index',
  },
];

const STAGE_LABEL: Record<JobStage, string> = {
  queued: 'queued',
  cloning: 'cloning',
  parsing: 'parsing',
  embedding: 'embedding',
  finalising: 'finalising',
  ready: 'ready',
  failed: 'failed',
};

export function IndexProgress({
  job,
  repoName,
  pollError,
  isRetrying,
  onRetry,
  onUseSample,
  onCancel,
  onComplete,
}: IndexProgressProps) {
  const isFailed = job.stage === 'failed';
  const isReady = job.stage === 'ready';
  // When failed, the scene stays where it broke rather than jumping to the start.
  const activeStage: JobStage = isFailed ? (job.failedStage ?? 'queued') : job.stage;

  // Index of the stage in progress (or the one that failed); -1 while queued.
  const currentStageIndex = STAGES_META.findIndex((s) => s.id === activeStage);

  const displayPercent = Math.max(0, Math.min(100, Math.round(job.progress)));

  // Caravan X coordinate percentage (clamped between 8% and 94%)
  let caravanX = 12;
  if (activeStage === 'cloning') caravanX = 18;
  else if (activeStage === 'parsing') caravanX = 40;
  else if (activeStage === 'embedding') caravanX = 64;
  else if (activeStage === 'finalising') caravanX = 84;
  else if (activeStage === 'ready') caravanX = 94;

  return (
    <div
      id="screen-indexing-progress"
      className="relative w-full max-w-3xl mx-auto px-4 sm:px-6 py-8 z-10 font-mono-dune"
    >
      {/* Top Bar Navigation */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-2 font-mono-dune text-xs text-[#C89B6B] hover:text-[#F0DFB4] transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back to repository connect</span>
        </button>
      </div>

      {/* Main Status Header */}
      <div className="mb-6">
        <div className="font-mono-dune text-xs tracking-widest text-[#C89B6B] uppercase mb-1.5 flex items-center gap-2">
          <Compass className="w-4 h-4 text-[#F0DFB4]" />
          <span>CARTOGRAPHY EXPEDITION IN PROGRESS</span>
        </div>

        <h1 className="font-serif-dune text-3xl sm:text-4xl text-[#EAE2D4] font-normal flex items-center gap-3">
          {!isFailed && !isReady && (
            <Loader2 className="w-6 h-6 animate-spin text-[#C89B6B] shrink-0" />
          )}
          {isFailed ? (
            <span className="text-red-400 font-serif-dune">
              Could not index {repoName}
            </span>
          ) : isReady ? (
            <span className="text-[#F0DFB4] font-serif-dune">
              Topography Charted & Ready
            </span>
          ) : (
            <span>
              {activeStage === 'cloning' && 'Surveying Repository Worktree'}
              {activeStage === 'parsing' && 'Contouring Abstract Syntax Dunes'}
              {activeStage === 'embedding' && 'Vectorizing Semantic Code Valleys'}
              {activeStage === 'finalising' && 'Weaving Call-Graph Constellations'}
              {activeStage === 'queued' && 'Preparing Expedition Gear'}
            </span>
          )}
        </h1>

        <div className="font-mono-dune text-xs text-[#EAE2D4]/70 mt-2 flex flex-wrap items-center gap-4">
          <div>
            Repository: <span className="text-[#F0DFB4] font-semibold">{repoName}</span>
          </div>
          <span className="text-[#3A2B33] hidden sm:inline">•</span>
          <div>
            {isFailed ? 'Failed while' : 'Current Stage'}:{' '}
            <span className={`uppercase font-semibold ${isFailed ? 'text-red-400' : 'text-[#C89B6B]'}`}>
              {STAGE_LABEL[activeStage]}
            </span>
          </div>
          {job.detail && !isFailed && (
            <>
              <span className="text-[#3A2B33] hidden sm:inline">•</span>
              <div className="text-[#F0DFB4] tabular-nums">{job.detail}</div>
            </>
          )}
        </div>
        {!isFailed && !isReady && (
          <p className="font-mono-dune text-[11px] text-[#EAE2D4]/50 mt-1.5">
            This usually takes under two minutes.
          </p>
        )}
        {pollError && !isFailed && (
          <p role="status" className="font-mono-dune text-[11px] text-amber-300 mt-1.5">
            Lost contact with the API ({pollError}) Still trying.
          </p>
        )}
      </div>

      {/* ========================================================================= */}
      {/* VISUAL REPRESENTATION: Desert Night Forming Dunes & Advancing Caravan     */}
      {/* ========================================================================= */}
      <div
        id="desert-indexing-canvas"
        className="mb-6 border border-[#3A2B33] bg-[#0A0B14]/90 backdrop-blur-md rounded-2xl overflow-hidden shadow-2xl relative"
      >
        {/* Stage Status Ribbon */}
        <div className="px-5 py-3 border-b border-[#3A2B33] flex flex-wrap items-center justify-between gap-2 bg-[#171833]/40">
          <div className="flex items-center gap-2">
            <span
              className={`w-2.5 h-2.5 rounded-full ${
                isFailed
                  ? 'bg-red-500 animate-ping'
                  : isReady
                  ? 'bg-[#F0DFB4] shadow-[0_0_8px_#F0DFB4]'
                  : 'bg-[#C89B6B] animate-pulse'
              }`}
            />
            <span className="text-xs font-serif-dune font-semibold text-[#F0DFB4]">
              {isFailed
                ? 'Expedition Halted'
                : isReady
                ? 'Atlas Survey Complete'
                : `Active Phase: ${activeStage.toUpperCase()}`}
            </span>
          </div>

          <div className="flex items-center gap-3 text-xs font-mono-dune">
            <span className="text-[#C89B6B]">Progress:</span>
            <span className="text-[#F0DFB4] font-bold text-sm">
              {displayPercent}%
            </span>
          </div>
        </div>

        {/* Dynamic Desert Night Panoramic Stage */}
        <div className="relative h-56 sm:h-64 w-full overflow-hidden bg-gradient-to-b from-[#0A0B14] via-[#171833] to-[#241C2E] select-none">
          {/* Crescent Moon with Soft Glow */}
          <div className="absolute top-4 right-8 pointer-events-none">
            <div className="w-16 h-16 rounded-full bg-[#F0DFB4]/20 blur-xl absolute -inset-2" />
            <svg viewBox="0 0 32 32" className="w-10 h-10 text-[#F0DFB4] relative filter drop-shadow-[0_0_10px_rgba(240,223,180,0.5)]">
              <path
                d="M 22 4 C 13 4 6 11 6 20 C 6 25 8 28 11 30 C 9 27 8 24 8 20 C 8 13 13 8 20 8 C 22 8 24 9 26 10 C 25 6 24 4 22 4 Z"
                fill="currentColor"
              />
            </svg>
          </div>

          {/* Twinkling Stars in Desert Night Sky */}
          <div className="absolute inset-0 pointer-events-none">
            {[
              { x: 10, y: 18, size: 2, delay: 0 },
              { x: 22, y: 32, size: 1.5, delay: 1.4 },
              { x: 38, y: 15, size: 2.5, delay: 2.1 },
              { x: 50, y: 28, size: 1, delay: 0.7 },
              { x: 68, y: 20, size: 2, delay: 1.8 },
              { x: 80, y: 34, size: 1.5, delay: 3.2 },
              { x: 92, y: 16, size: 2, delay: 0.5 },
            ].map((st, i) => (
              <div
                key={i}
                className="absolute rounded-full bg-[#F0DFB4] animate-pulse"
                style={{
                  left: `${st.x}%`,
                  top: `${st.y}%`,
                  width: `${st.size}px`,
                  height: `${st.size}px`,
                  animationDelay: `${st.delay}s`,
                  boxShadow: '0 0 4px rgba(240,223,180,0.8)',
                }}
              />
            ))}
          </div>

          {/* Call-graph constellation lines (illuminated during FINALISING and READY) */}
          {(activeStage === 'finalising' || isReady) && (
            <svg className="absolute inset-0 w-full h-full pointer-events-none opacity-60">
              <line x1="15%" y1="45%" x2="35%" y2="28%" stroke="#F0DFB4" strokeWidth="1" strokeDasharray="3 3" />
              <line x1="35%" y1="28%" x2="60%" y2="38%" stroke="#C89B6B" strokeWidth="1" strokeDasharray="3 3" />
              <line x1="60%" y1="38%" x2="85%" y2="22%" stroke="#F0DFB4" strokeWidth="1.5" strokeDasharray="4 2" />
              <circle cx="15%" cy="45%" r="3" fill="#F0DFB4" />
              <circle cx="35%" cy="28%" r="4" fill="#C89B6B" />
              <circle cx="60%" cy="38%" r="3" fill="#F0DFB4" />
              <circle cx="85%" cy="22%" r="5" fill="#F0DFB4" />
            </svg>
          )}

          {/* Stardust vector particles (illuminated during EMBEDDING) */}
          {activeStage === 'embedding' && (
            <div className="absolute inset-0 pointer-events-none">
              {[...Array(12)].map((_, idx) => (
                <div
                  key={idx}
                  className="absolute w-1 h-1 bg-[#C89B6B] rounded-full animate-ping"
                  style={{
                    left: `${20 + (idx * 6)}%`,
                    top: `${35 + (idx % 4) * 8}%`,
                    animationDuration: `${1.5 + (idx % 3)}s`,
                  }}
                />
              ))}
            </div>
          )}

          {/* Sandstorm Gale overlay (shown during FAILED) */}
          {isFailed && (
            <div className="absolute inset-0 pointer-events-none bg-red-950/20 z-20 flex flex-col justify-center items-center backdrop-blur-[1px]">
              <div className="absolute inset-0 bg-gradient-to-r from-red-950/40 via-amber-950/30 to-red-950/40 animate-pulse" />
              <div className="border border-red-500/60 bg-[#0A0B14]/95 px-4 py-2.5 rounded-xl shadow-2xl flex items-center gap-2 text-red-300 font-mono-dune text-xs z-30">
                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                <span>SANDSTORM: indexing stopped while {STAGE_LABEL[activeStage]}</span>
              </div>
            </div>
          )}

          {/* LAYER 1: Far Dune Silhouette (#241C2E) */}
          <svg
            viewBox="0 0 1000 300"
            preserveAspectRatio="none"
            className="absolute bottom-0 w-full h-44 pointer-events-none"
            fill="none"
          >
            <path
              d={
                activeStage === 'cloning'
                  ? 'M 0,160 Q 250,130 500,150 T 1000,120 L 1000,300 L 0,300 Z'
                  : activeStage === 'parsing'
                  ? 'M 0,140 Q 220,90 480,130 T 1000,95 L 1000,300 L 0,300 Z'
                  : 'M 0,130 Q 240,80 500,120 T 1000,85 L 1000,300 L 0,300 Z'
              }
              fill="#241C2E"
              opacity="0.9"
            />
          </svg>

          {/* LAYER 2: Mid Dune Silhouette (#3A2B33) with forming contour ridges */}
          <svg
            viewBox="0 0 1000 300"
            preserveAspectRatio="none"
            className="absolute bottom-0 w-full h-36 pointer-events-none"
            fill="none"
          >
            {/* Mid Dune body */}
            <path
              d={
                activeStage === 'cloning'
                  ? 'M 0,120 Q 280,110 520,135 T 1000,105 L 1000,300 L 0,300 Z'
                  : activeStage === 'parsing'
                  ? 'M 0,105 Q 260,60 520,110 T 1000,85 L 1000,300 L 0,300 Z'
                  : activeStage === 'embedding'
                  ? 'M 0,95 Q 300,50 560,115 T 1000,75 L 1000,300 L 0,300 Z'
                  : 'M 0,85 Q 280,45 540,100 T 1000,65 L 1000,300 L 0,300 Z'
              }
              fill="#3A2B33"
            />
            {/* Dune contour ridge line */}
            <path
              d={
                activeStage === 'cloning'
                  ? 'M 0,120 Q 280,110 520,135 T 1000,105'
                  : activeStage === 'parsing'
                  ? 'M 0,105 Q 260,60 520,110 T 1000,85'
                  : activeStage === 'embedding'
                  ? 'M 0,95 Q 300,50 560,115 T 1000,75'
                  : 'M 0,85 Q 280,45 540,100 T 1000,65'
              }
              stroke="#57392C"
              strokeWidth="1.5"
            />
          </svg>

          {/* LAYER 3: Near Dune Silhouette (#57392C) with illuminated Moonlit Crest */}
          <svg
            viewBox="0 0 1000 300"
            preserveAspectRatio="none"
            className="absolute bottom-0 w-full h-28 pointer-events-none"
            fill="none"
          >
            {/* Near Dune body */}
            <path
              d="M 0,80 Q 240,30 480,75 T 1000,45 L 1000,300 L 0,300 Z"
              fill="#57392C"
            />
            {/* Glowing Moonlit Crest line */}
            <path
              d="M 0,80 Q 240,30 480,75 T 1000,45"
              stroke="#C89B6B"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
            {/* Secondary warm highlight */}
            <path
              d="M 0,80 Q 240,30 480,75 T 1000,45"
              stroke="#F0DFB4"
              strokeWidth="1"
              opacity="0.8"
            />
          </svg>

          {/* WAYPOINT MILESTONE PILLARS ALONG THE RIDGE */}
          <div className="absolute bottom-6 left-0 right-0 px-8 flex justify-between pointer-events-none z-10">
            {[
              { id: 'cloning', label: '1. Git Refs', x: '18%' },
              { id: 'parsing', label: '2. AST Contours', x: '40%' },
              { id: 'embedding', label: '3. Vector Basin', x: '64%' },
              { id: 'finalising', label: '4. Call Constellation', x: '84%' },
              { id: 'ready', label: '5. Oasis Summit', x: '94%' },
            ].map((wp) => {
              const wpIndex = STAGES_META.findIndex((st) => st.id === wp.id);
              const wpPassed =
                isReady || (wpIndex !== -1 && currentStageIndex !== -1 && wpIndex <= currentStageIndex);

              const wpActive = activeStage === wp.id;

              return (
                <div
                  key={wp.id}
                  className="flex flex-col items-center"
                  style={{ transform: 'translateY(-10px)' }}
                >
                  <div
                    className={`w-3 h-3 rounded-full border flex items-center justify-center transition-all duration-500 ${
                      wpActive
                        ? 'border-[#F0DFB4] bg-[#C89B6B] shadow-[0_0_8px_#F0DFB4] scale-125'
                        : wpPassed
                        ? 'border-[#C89B6B] bg-[#F0DFB4]'
                        : 'border-[#3A2B33] bg-[#0A0B14]'
                    }`}
                  >
                    {wpPassed && !wpActive && (
                      <span className="w-1 h-1 rounded-full bg-[#0A0B14]" />
                    )}
                  </div>
                  <span
                    className={`text-[9px] font-mono-dune mt-1 tracking-tight hidden md:inline ${
                      wpActive
                        ? 'text-[#F0DFB4] font-bold'
                        : wpPassed
                        ? 'text-[#C89B6B]'
                        : 'text-[#3A2B33]'
                    }`}
                  >
                    {wp.label}
                  </span>
                </div>
              );
            })}
          </div>

          {/* ADVANCING CARAVAN: Animated traversing along the moonlit ridge */}
          <div
            className="absolute bottom-12 transition-all duration-700 ease-out pointer-events-none z-20"
            style={{
              left: `calc(${caravanX}% - 48px)`,
            }}
          >
            <div className="relative flex items-end">
              {/* Halting Beacon if failed */}
              {isFailed && (
                <div className="absolute -top-6 -left-2 flex items-center gap-1 bg-red-950 border border-red-500/80 px-2 py-0.5 rounded text-[10px] text-red-200 font-bold animate-bounce">
                  <span>HALTED</span>
                </div>
              )}

              {/* Ready celebration banner */}
              {isReady && (
                <div className="absolute -top-7 -right-2 flex items-center gap-1 bg-[#F0DFB4] text-[#0A0B14] px-2 py-0.5 rounded text-[10px] font-bold shadow-lg">
                  <Sparkles className="w-2.5 h-2.5" />
                  <span>CHARTED</span>
                </div>
              )}

              {/* 3 Tethered Camels Caravan */}
              <div className="flex items-end gap-1.5 filter drop-shadow-[0_4px_10px_rgba(240,223,180,0.35)]">
                {/* Pack Camel 1 */}
                <div className="opacity-80">
                  <CamelSilhouette className="w-8 h-6 text-[#F0DFB4]" />
                </div>
                {/* Pack Camel 2 */}
                <div className="opacity-90">
                  <CamelSilhouette className="w-9 h-7 text-[#F0DFB4]" />
                </div>
                {/* Lead Guide Camel with glowing lantern */}
                <div className="relative">
                  <CamelSilhouette className="w-11 h-8 text-[#F0DFB4]" />
                  <span className="absolute top-2 right-0 w-1.5 h-1.5 rounded-full bg-[#F0DFB4] shadow-[0_0_6px_#FFF]" />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Live Stage Subtitle & Descriptive Storyline */}
        <div className="p-4 bg-[#0A0B14] border-t border-[#3A2B33] flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          <div>
            <div className="text-[#F0DFB4] font-semibold flex items-center gap-2">
              <Layers className="w-3.5 h-3.5 text-[#C89B6B]" />
              {isFailed && `Survey Suspended while ${STAGE_LABEL[activeStage]}`}
              {!isFailed && activeStage === 'queued' && 'Waiting to start'}
              {!isFailed && activeStage === 'cloning' && 'Stage 1 of 4: Downloading the Repository'}
              {!isFailed && activeStage === 'parsing' && 'Stage 2 of 4: Parsing and Import Graph'}
              {!isFailed && activeStage === 'embedding' && 'Stage 3 of 4: Embedding Code Chunks'}
              {!isFailed && activeStage === 'finalising' && 'Stage 4 of 4: Storing the Index'}
              {isReady && 'Cartography Complete: Repository Terrain Fully Charted'}
            </div>
            <p className="text-[#C89B6B]/80 text-[11px] mt-0.5">
              {isFailed && 'See the reason below.'}
              {!isFailed && activeStage === 'queued' && 'The indexing job has been accepted and is starting.'}
              {!isFailed && activeStage === 'cloning' &&
                'Fetching the default branch at its current commit. Dependencies, build output and large files are skipped.'}
              {!isFailed && activeStage === 'parsing' &&
                'Reading .ts, .tsx, .js and .jsx files with tree-sitter to find imports, exports, routes and entry points.'}
              {!isFailed && activeStage === 'embedding' &&
                'Splitting files into chunks and embedding each one, so questions can be matched to code.'}
              {!isFailed && activeStage === 'finalising' &&
                'Writing the graph, the route table and the vectors, then laying out the map.'}
              {isReady && 'The map, the search index and the source snapshot are ready.'}
            </p>
          </div>

          {/* Quick Action Button */}
          {isReady && (
            <button
              id="btn-enter-codebase-map"
              onClick={onComplete}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-[#F0DFB4] hover:bg-white text-[#0A0B14] font-bold text-xs uppercase tracking-wider rounded-lg transition-all shadow-md cursor-pointer shrink-0"
            >
              <span>Explore Codebase Map</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Illuminated Bottom Progress Bar */}
        <div className="w-full h-1.5 bg-[#171833] overflow-hidden">
          <div
            className={`h-full transition-all duration-500 ease-out ${
              isFailed ? 'bg-red-500' : 'bg-[#C89B6B]'
            }`}
            style={{
              width: `${displayPercent}%`,
              boxShadow: isFailed
                ? '0 0 10px rgba(239, 68, 68, 0.7)'
                : '0 0 12px rgba(200, 155, 107, 0.7)',
            }}
          />
        </div>
      </div>

      {/* ========================================================================= */}
      {/* FAILURE DIAGNOSTIC VIEW                                                   */}
      {/* ========================================================================= */}
      {isFailed && (
        <div role="alert" className="mb-6 border border-red-500/40 bg-[#241C2E]/80 p-5 rounded-xl shadow-xl">
          <div className="flex items-center gap-2 text-red-400 font-bold mb-3 uppercase tracking-wider text-xs">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>Indexing stopped while {STAGE_LABEL[activeStage]}</span>
          </div>

          <div className="text-[#EAE2D4]/90 bg-[#171833]/60 p-3.5 border border-[#3A2B33] mb-5 text-xs leading-relaxed rounded-lg">
            {job.failureReason ?? 'The indexing job failed without giving a reason. Try again.'}
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              id="btn-retry-index"
              onClick={onRetry}
              disabled={isRetrying}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#F0DFB4] hover:bg-white text-[#0A0B14] font-bold text-xs uppercase tracking-wider transition-colors cursor-pointer rounded-lg shadow-sm disabled:opacity-60 disabled:cursor-wait"
            >
              {isRetrying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              <span>Try Again</span>
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2.5 border border-[#3A2B33] hover:bg-[#171833]/60 text-[#EAE2D4]/80 hover:text-white text-xs uppercase tracking-wider transition-colors cursor-pointer rounded-lg"
            >
              Try Another Repo
            </button>
            <button
              type="button"
              onClick={onUseSample}
              disabled={isRetrying}
              className="px-4 py-2.5 border border-[#3A2B33] hover:bg-[#171833]/60 text-[#EAE2D4]/80 hover:text-white text-xs uppercase tracking-wider transition-colors cursor-pointer rounded-lg disabled:opacity-60"
            >
              Use Sample Repo
            </button>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* STAGE BREAKDOWN CHECKLIST: Dunes Forming Progress                         */}
      {/* ========================================================================= */}
      <div className="mb-6 border border-[#3A2B33] bg-[#0A0B14]/90 backdrop-blur-md p-5 rounded-xl">
        <div className="text-xs uppercase tracking-wider text-[#C89B6B] font-semibold mb-3 flex items-center gap-2 border-b border-[#3A2B33]/80 pb-2">
          <MapPin className="w-3.5 h-3.5 text-[#F0DFB4]" />
          <span>Expedition Waypoint Milestones</span>
        </div>

        <div className="space-y-2.5 text-xs">
          {STAGES_META.map((s, index) => {
            const isPast = isReady || (currentStageIndex !== -1 && index < currentStageIndex);
            const isCurrent = !isReady && !isFailed && activeStage === s.id;
            const isFailedHere = isFailed && activeStage === s.id;
            const isPending = !isReady && !isPast && !isCurrent && !isFailedHere;

            return (
              <div
                key={s.id}
                className={`flex items-center justify-between p-3 transition-colors border rounded-lg ${
                  isFailedHere
                    ? 'border-red-500/60 bg-red-950/30'
                    : isCurrent
                    ? 'border-[#C89B6B] bg-[#241C2E]/70 shadow-[0_0_12px_rgba(200,155,107,0.15)]'
                    : isPast
                    ? 'border-[#3A2B33]/60 bg-[#171833]/30'
                    : 'border-transparent opacity-45'
                }`}
              >
                <div className="flex items-center gap-3">
                  {isFailedHere ? (
                    <span className="w-5 h-5 rounded-full bg-red-500 text-[#0A0B14] flex items-center justify-center font-bold">
                      <X className="w-3 h-3" />
                    </span>
                  ) : isPast ? (
                    <span className="w-5 h-5 rounded-full bg-[#F0DFB4] text-[#0A0B14] flex items-center justify-center font-bold">
                      <Check className="w-3 h-3" />
                    </span>
                  ) : isCurrent ? (
                    <span className="w-5 h-5 rounded-full border border-[#F0DFB4] bg-[#C89B6B] flex items-center justify-center text-[#0A0B14] font-bold animate-pulse">
                      ◉
                    </span>
                  ) : (
                    <span className="w-5 h-5 flex items-center justify-center text-[#57392C]">
                      <Circle className="w-3.5 h-3.5" />
                    </span>
                  )}

                  <div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`font-semibold tracking-wider ${
                          isFailedHere
                            ? 'text-red-300'
                            : isPast
                            ? 'text-[#F0DFB4]'
                            : isCurrent
                            ? 'text-[#F0DFB4] font-bold'
                            : 'text-[#EAE2D4]/50'
                        }`}
                      >
                        {s.label}
                      </span>
                      <span className="text-[11px] text-[#C89B6B]">
                        • {s.title}
                      </span>
                    </div>
                    <div className="text-[11px] text-[#EAE2D4]/60 mt-0.5 hidden sm:block">
                      {s.desc}
                    </div>
                  </div>
                </div>

                <div className="text-right shrink-0">
                  {isCurrent && (
                    <span className="text-[10px] text-[#F0DFB4] bg-[#241C2E] border border-[#C89B6B]/60 px-2 py-0.5 rounded font-bold animate-pulse tabular-nums">
                      {job.detail ?? 'SURVEYING...'}
                    </span>
                  )}
                  {isFailedHere && (
                    <span className="text-[10px] text-red-300 bg-red-950/50 border border-red-500/50 px-2 py-0.5 rounded font-bold">
                      FAILED
                    </span>
                  )}
                  {isPast && (
                    <span className="text-[10px] text-[#C89B6B] bg-[#171833] border border-[#3A2B33] px-2 py-0.5 rounded">
                      CHARTED
                    </span>
                  )}
                  {isPending && (
                    <span className="text-[10px] text-[#57392C]">
                      PENDING
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

    </div>
  );
}
