import { useMemo } from 'react';
import {
  ReactFlow,
  Background,
  useReactFlow,
  ReactFlowProvider,
  MarkerType,
  type Edge,
  type Node,
} from '@xyflow/react';
import { Plus, Minus, Maximize, Layers } from 'lucide-react';
import type { Answer, Graph } from '@dune/shared/types';
import { CustomGraphNode, KIND_STYLES, type GraphNodeViewData } from './CustomGraphNode';
import { DesertDunes } from './DesertDunes';

interface GraphViewProps {
  graph: Graph | null;
  isLoading: boolean;
  activeAnswer: Answer | null;
  selectedFilePath: string | null;
  onSelectFile: (filePath: string) => void;
  isProcessingQuery?: boolean;
}

const FIT_OPTIONS = { padding: 0.06, maxZoom: 1 };

const nodeTypes = {
  customFile: CustomGraphNode,
};

function GraphInner({
  graph,
  isLoading,
  activeAnswer,
  selectedFilePath,
  onSelectFile,
  isProcessingQuery = false,
}: GraphViewProps) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  // Highlight logic based on Answer
  const recommendedFile = activeAnswer?.recommendedFile || null;
  const attachToFile = activeAnswer?.attachTo || null;
  // Files the answer points at besides the recommendation: its sources, the tests to
  // update, the candidates, and any `affected` entry that is a file rather than a route.
  const relatedFiles = useMemo(() => {
    if (!activeAnswer) return new Set<string>();
    return new Set([
      ...activeAnswer.sources.map((s) => s.file),
      ...activeAnswer.testsToUpdate,
      ...(activeAnswer.candidates ?? []).map((c) => c.file),
      ...activeAnswer.affected,
    ]);
  }, [activeAnswer]);

  // Transform graph data into React Flow nodes & edges
  const { nodes, edges } = useMemo(() => {
    if (!graph) {
      return { nodes: [], edges: [] };
    }

    const hasActiveQuery = !!activeAnswer;

    // Positions are pre-computed by the backend; the frontend never lays out.
    const rfNodes: Node<GraphNodeViewData>[] = graph.nodes.map((n) => {
      const isRecommended = n.id === recommendedFile || n.id === attachToFile;

      // A directory candidate ("src/middleware/") marks every file under it.
      const isAffected =
        relatedFiles.has(n.id) ||
        [...relatedFiles].some((f) => f.endsWith('/') && n.id.startsWith(f));

      const isSelected = selectedFilePath === n.id;

      // Dim unrelated if we have an active answer with recommended/affected nodes
      const isDimmed =
        hasActiveQuery && !isRecommended && !isAffected && !isSelected;

      return {
        id: n.id,
        type: 'customFile',
        position: { x: n.x, y: n.y },
        data: {
          node: n,
          isRecommended,
          isAffected,
          isDimmed,
          isSelected,
          onSelectNode: onSelectFile,
        },
      };
    });

    const rfEdges: Edge[] = graph.edges.map((e) => {
      const isConnectedToRec =
        recommendedFile !== null && (e.from === recommendedFile || e.to === recommendedFile);

      return {
        id: `${e.from}->${e.to}`,
        source: e.from,
        target: e.to,
        type: 'smoothstep',
        animated: isConnectedToRec ? true : false,
        style: {
          stroke: isConnectedToRec ? '#F0DFB4' : '#57392C',
          strokeWidth: isConnectedToRec ? 2 : 1.2,
          opacity: hasActiveQuery && !isConnectedToRec ? 0.35 : 0.85,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 12,
          height: 12,
          color: isConnectedToRec ? '#C89B6B' : '#57392C',
        },
      };
    });

    return { nodes: rfNodes, edges: rfEdges };
  }, [
    graph,
    activeAnswer,
    selectedFilePath,
    recommendedFile,
    attachToFile,
    relatedFiles,
    onSelectFile,
  ]);

  const presentKinds = useMemo(() => {
    const kinds = new Set(graph?.nodes.map((n) => n.kind));
    return (Object.keys(KIND_STYLES) as (keyof typeof KIND_STYLES)[]).filter((k) => kinds.has(k));
  }, [graph]);

  // Loading state
  if (isLoading) {
    return (
      <div id="graph-loading-state" className="w-full h-full flex flex-col items-center justify-center bg-[#0A0B14] font-mono-dune text-[#EAE2D4]">
        <div className="border border-[#3A2B33] bg-[#171833]/50 p-6 text-center max-w-sm rounded-xl shadow-2xl backdrop-blur-sm">
          <div className="font-serif-dune text-sm font-semibold text-[#F0DFB4] tracking-wide mb-2">
            Surveying Codebase Topography
          </div>
          <div className="w-48 h-1.5 bg-[#0A0B14] mx-auto my-3 overflow-hidden rounded-full border border-[#3A2B33]">
            <div className="h-full bg-[#C89B6B] animate-pulse rounded-full" style={{ width: '65%' }} />
          </div>
          <p className="text-[11px] text-[#C89B6B]/80 font-mono-dune">
            Resolving deterministic import tree and cluster coordinates...
          </p>
        </div>
      </div>
    );
  }

  // Empty state
  if (!graph || graph.nodes.length === 0) {
    return (
      <div id="graph-empty-state" className="w-full h-full flex items-center justify-center bg-[#0A0B14] font-mono-dune p-8">
        <div className="border border-[#3A2B33] bg-[#171833]/40 p-8 max-w-md text-center rounded-xl shadow-2xl">
          <div className="font-serif-dune text-base font-semibold text-[#F0DFB4] mb-2">
            No Topographical Data
          </div>
          <p className="text-xs text-[#EAE2D4]/70 leading-relaxed font-mono-dune">
            The repository did not contain enough supported source relationships to build an atlas map.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div id="codebase-map-canvas" className="w-full h-full relative bg-[#0A0B14] overflow-hidden">
      {/* Background Dune Layers with subtle moon glow during AI query processing */}
      <DesertDunes
        isProcessing={isProcessingQuery}
        className="opacity-35"
        showCaravan={false}
      />

      {/* Cluster directory legends in canvas */}
      <div className="absolute top-3 left-4 z-10 pointer-events-none font-mono-dune text-[10px] text-[#EAE2D4]/80 flex items-center gap-4 bg-[#0A0B14]/90 backdrop-blur-md px-3 py-1.5 border border-[#3A2B33] rounded-md shadow-md">
        <span className="flex items-center gap-1.5 text-[#F0DFB4] font-serif-dune font-semibold text-xs tracking-wide">
          <Layers className="w-3.5 h-3.5 text-[#C89B6B]" /> Codebase Map
        </span>
        <span className="text-[#3A2B33]">|</span>
        {presentKinds.map((kind) => (
          <span key={kind} className="flex items-center gap-1">
            <span className={`w-2 h-2 border rounded-xs ${KIND_STYLES[kind].swatch}`} /> {KIND_STYLES[kind].legend}
          </span>
        ))}
      </div>

      {/* Isolated files never reach the frontend; the backend reports how many. */}
      {graph.hiddenCount > 0 && (
        <div className="absolute bottom-4 right-4 z-10 font-mono-dune text-[11px] bg-[#0A0B14]/90 backdrop-blur-md border border-[#3A2B33] px-3 py-1.5 text-[#EAE2D4]/80 rounded-md shadow-md pointer-events-none">
          showing {graph.nodes.length} of {graph.nodes.length + graph.hiddenCount} files; isolated files hidden
        </div>
      )}

      {/* React Flow Viewport */}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        // Fit the whole map on load. The backend lays it out near-landscape, so this lands at
        // a readable zoom rather than shrinking a long strip.
        fitView
        fitViewOptions={FIT_OPTIONS}
        minZoom={0.2}
        maxZoom={1.8}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#3A2B33" gap={24} size={1} />
      </ReactFlow>

      {/* Graph Controls: +, -, FIT */}
      <div
        id="graph-controls-panel"
        className="absolute bottom-4 left-4 z-20 flex items-center bg-[#0A0B14]/95 backdrop-blur-md border border-[#3A2B33] font-mono-dune text-xs shadow-xl divide-x divide-[#3A2B33] rounded-lg overflow-hidden"
      >
        <button
          id="btn-graph-zoom-in"
          onClick={() => zoomIn()}
          title="Zoom In (+)"
          className="p-2 text-[#EAE2D4]/80 hover:text-[#F0DFB4] hover:bg-[#171833]/60 transition-colors cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
        <button
          id="btn-graph-zoom-out"
          onClick={() => zoomOut()}
          title="Zoom Out (−)"
          className="p-2 text-[#EAE2D4]/80 hover:text-[#F0DFB4] hover:bg-[#171833]/60 transition-colors cursor-pointer"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
        <button
          id="btn-graph-fit-view"
          onClick={() => fitView({ ...FIT_OPTIONS, duration: 300 })}
          title="Fit View"
          className="px-2.5 py-2 text-[11px] font-bold text-[#EAE2D4]/90 hover:text-[#F0DFB4] hover:bg-[#171833]/60 transition-colors cursor-pointer flex items-center gap-1"
        >
          <Maximize className="w-3 h-3 text-[#C89B6B]" />
          <span>FIT</span>
        </button>
      </div>
    </div>
  );
}

export function GraphView(props: GraphViewProps) {
  return (
    <ReactFlowProvider>
      <GraphInner {...props} />
    </ReactFlowProvider>
  );
}
