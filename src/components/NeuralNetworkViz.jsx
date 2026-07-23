import { useCallback, useEffect, useRef, useState } from 'react';
import {
  COGNITIVE_MODULES_PIPELINE_ORDER,
  getPipelineStageColorForModuleId,
  getPipelineStageLabelForModuleId,
} from '../lib/cognitiveModules';
import { cn } from '../lib/utils';

const HIT_RADIUS = 26;

function findModuleAtCanvasXY(nodes, x, y) {
  for (const node of nodes) {
    const dist = Math.hypot(x - node.x, y - node.y);
    if (dist < HIT_RADIUS) return node.module;
  }
  return null;
}

const DEFAULT_ARIA_LABEL = 'Cognitive modules connected in a ring';

export default function NeuralNetworkViz({
  activeModuleId = null,
  /** Dual playground: pulse/edge color while System A (blue) or B (red) is active; default cyan. */
  runAccent = null,
  variant = 'default',
  ariaLabel = DEFAULT_ARIA_LABEL,
  className,
} = {}) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const animRef = useRef(null);
  const nodesRef = useRef([]);
  const activeModuleIdRef = useRef(null);
  activeModuleIdRef.current = activeModuleId;
  const runAccentRef = useRef(runAccent);
  runAccentRef.current = runAccent;
  /** Pinned card: module + position in wrapper coords */
  const [pinned, setPinned] = useState(null);
  const pinnedRef = useRef(null);
  pinnedRef.current = pinned;
  const [hoverModule, setHoverModule] = useState(null);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });

  const toWrapCoords = useCallback((clientX, clientY) => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: clientX - r.left, y: clientY - r.top };
  }, []);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) {
      return undefined;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return undefined;
    }

    /** Size from the wrapper — parent chain in flex / horizontal carousels often lays out after first paint. */
    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const width = () => canvas.width / (window.devicePixelRatio || 1);
    const height = () => canvas.height / (window.devicePixelRatio || 1);

    const getNodePositions = () => {
      const cx = width() / 2;
      const cy = height() / 2;
      const n = COGNITIVE_MODULES_PIPELINE_ORDER.length;
      const labelPad = 72;
      const maxR = Math.min(cx, cy) - labelPad;
      const outerCount = Math.ceil(n / 2);
      const innerCount = n - outerCount;
      const rOuter = Math.max(44, maxR * 0.92);
      const rInner = Math.max(36, maxR * 0.58);

      return COGNITIVE_MODULES_PIPELINE_ORDER.map((module, index) => {
        const onOuter = index < outerCount;
        const ringCount = onOuter ? outerCount : innerCount;
        const ringIndex = onOuter ? index : index - outerCount;
        let angle = (ringIndex / ringCount) * Math.PI * 2 - Math.PI / 2;
        if (!onOuter) {
          angle += Math.PI / outerCount;
        }
        const R = onOuter ? rOuter : rInner;
        return {
          x: cx + Math.cos(angle) * R,
          y: cy + Math.sin(angle) * R,
          angle,
          module,
        };
      });
    };

    const getConnections = (nodes) => {
      const connections = [];
      for (let index = 0; index < nodes.length; index += 1) {
        connections.push([index, (index + 1) % nodes.length]);
        if (index % 2 === 0) {
          connections.push([index, (index + 4) % nodes.length]);
        }
        if (index % 3 === 0) {
          connections.push([index, (index + 7) % nodes.length]);
        }
      }
      return connections;
    };

    let time = 0;
    const accentRgb = () => {
      const a = runAccentRef.current;
      if (a === 'a') return [59, 130, 246];
      if (a === 'b') return [239, 68, 68];
      return [6, 182, 212];
    };

    const animate = () => {
      ctx.clearRect(0, 0, width(), height());
      time += 0.01;

      const [r, g, b] = accentRgb();
      const cx = width() / 2;
      const cy = height() / 2;
      const maxR = Math.min(width(), height()) * 0.42;
      if (runAccentRef.current) {
        const hub = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR);
        hub.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.14)`);
        hub.addColorStop(0.55, `rgba(${r}, ${g}, ${b}, 0.04)`);
        hub.addColorStop(1, 'transparent');
        ctx.fillStyle = hub;
        ctx.fillRect(0, 0, width(), height());
      }

      const nodes = getNodePositions();
      nodesRef.current = nodes;
      const connections = getConnections(nodes);

      connections.forEach(([from, to]) => {
        const nodeA = nodes[from];
        const nodeB = nodes[to];
        const pulse = Math.sin(time * 2 + from * 0.5) * 0.5 + 0.5;

        ctx.beginPath();
        ctx.moveTo(nodeA.x, nodeA.y);
        ctx.lineTo(nodeB.x, nodeB.y);
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${0.06 + pulse * 0.12})`;
        ctx.lineWidth = 1;
        ctx.stroke();

        const progress = (time * 0.3 + from * 0.1) % 1;
        const px = nodeA.x + (nodeB.x - nodeA.x) * progress;
        const py = nodeA.y + (nodeB.y - nodeA.y) * progress;
        ctx.beginPath();
        ctx.arc(px, py, 1.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${pulse * 0.6})`;
        ctx.fill();
      });

      nodes.forEach((node, index) => {
        const isActive =
          Boolean(activeModuleIdRef.current) && node.module.id === activeModuleIdRef.current;
        const pulse = Math.sin(time * (isActive ? 3.4 : 1.5) + index * 0.7) * 0.5 + 0.5;
        const radius = 16 + pulse * (isActive ? 5 : 3);
        const stageColor = getPipelineStageColorForModuleId(node.module.id);
        const glowR = radius * (isActive ? 4.5 : 2.5);

        const gradient = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, glowR);
        gradient.addColorStop(0, isActive ? `${stageColor}aa` : `${stageColor}33`);
        gradient.addColorStop(0.45, isActive ? `${stageColor}55` : `${stageColor}18`);
        gradient.addColorStop(1, 'transparent');
        ctx.beginPath();
        ctx.arc(node.x, node.y, glowR, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.fill();

        if (isActive) {
          const ringPulse = Math.sin(time * 4.2) * 0.5 + 0.5;
          ctx.beginPath();
          ctx.arc(node.x, node.y, radius + 10 + ringPulse * 6, 0, Math.PI * 2);
          ctx.strokeStyle = `${stageColor}${Math.round(120 + ringPulse * 80)
            .toString(16)
            .padStart(2, '0')}`;
          ctx.lineWidth = 2.25;
          ctx.stroke();
        }

        ctx.beginPath();
        ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = isActive ? `${stageColor}55` : `${stageColor}22`;
        ctx.fill();
        ctx.strokeStyle = isActive ? `${stageColor}ee` : `${stageColor}88`;
        ctx.lineWidth = isActive ? 2.25 : 1.5;
        ctx.stroke();

        ctx.font = `bold ${Math.round(radius * 0.7)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = stageColor;
        ctx.fillText(node.module.name.charAt(0), node.x, node.y);
      });

      animRef.current = requestAnimationFrame(animate);
    };

    const onMouseMove = (event) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      setPointer(toWrapCoords(event.clientX, event.clientY));

      const mod = findModuleAtCanvasXY(nodesRef.current, x, y);
      setHoverModule(mod);
      canvas.style.cursor = mod ? 'pointer' : 'default';
    };

    const onMouseLeave = () => {
      setHoverModule(null);
      canvas.style.cursor = 'default';
    };

    const onClick = (event) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const mod = findModuleAtCanvasXY(nodesRef.current, x, y);
      const pos = toWrapCoords(event.clientX, event.clientY);

      if (!mod) {
        setPinned(null);
        return;
      }
      if (pinnedRef.current?.module?.id === mod.id) {
        setPinned(null);
        return;
      }
      setPinned({ module: mod, x: pos.x, y: pos.y });
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (animRef.current) {
          cancelAnimationFrame(animRef.current);
          animRef.current = null;
        }
      } else if (!animRef.current) {
        animRef.current = requestAnimationFrame(animate);
      }
    };

    resize();
    animate();
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVisibility);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
    if (ro) ro.observe(wrap);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseleave', onMouseLeave);
    canvas.addEventListener('click', onClick);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (ro) ro.disconnect();
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mouseleave', onMouseLeave);
      canvas.removeEventListener('click', onClick);
      if (animRef.current) {
        cancelAnimationFrame(animRef.current);
      }
    };
  }, [toWrapCoords]);

  const cardModule = pinned?.module ?? hoverModule;
  const cardPos = pinned ? { x: pinned.x, y: pinned.y } : pointer;
  const showPinnedHint = Boolean(pinned && hoverModule && hoverModule.id !== pinned.module.id);
  const cardStageColor = cardModule ? getPipelineStageColorForModuleId(cardModule.id) : '#64748b';
  const cardStageLabel = cardModule ? getPipelineStageLabelForModuleId(cardModule.id) : '';

  const wrapClass = cn(
    variant === 'embedded'
      ? 'relative h-full min-h-[12rem] w-full min-w-0'
      : 'relative h-full min-h-[400px] w-full',
    className
  );

  const canvasClass =
    variant === 'embedded' ? 'absolute inset-0 block h-full w-full' : 'h-full w-full';

  return (
    <div ref={wrapRef} className={wrapClass}>
      <canvas ref={canvasRef} className={canvasClass} role="img" aria-label={ariaLabel} />
      {cardModule && (
        <div
          className="pointer-events-none absolute z-10 max-w-[220px] rounded-lg border bg-card/95 px-3 py-2 text-xs shadow-lg backdrop-blur-sm"
          style={{
            left: `${Math.min(cardPos.x + 12, (wrapRef.current?.clientWidth ?? 400) - 200)}px`,
            top: `${cardPos.y + 12}px`,
            borderColor: `${cardStageColor}99`,
          }}
        >
          {cardStageLabel ? (
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {cardStageLabel}
            </div>
          ) : null}
          <div className="font-semibold leading-tight" style={{ color: cardStageColor }}>
            {cardModule.name}
          </div>
          <div className="mt-1 leading-snug text-foreground/75">{cardModule.description}</div>
          {showPinnedHint ? (
            <div className="mt-1 text-[10px] text-muted-foreground">Hovering a different module</div>
          ) : null}
        </div>
      )}
    </div>
  );
}
