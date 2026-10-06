export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PaneSlot {
  id: string;
  /** Whole pane including its frame. */
  rect: Rect;
  /** Top frame row: name and state. */
  header: Rect;
  /** Bottom frame row: cost and notices. */
  footer: Rect;
  /** Inside the frame: the hosted terminal. */
  body: Rect;
}

export interface LayoutInput {
  cols: number;
  rows: number;
  /** Main session first, then forks in display order. */
  ids: string[];
  focus?: string;
  zoom?: string;
  visibleForks: number;
  splitColumns: number;
}

export interface Layout {
  panes: PaneSlot[];
  /** Sessions that are running but not shown (reachable from the status bar). */
  hidden: string[];
  status: Rect;
  orientation: 'side' | 'stacked' | 'single';
}

const MIN_BODY = 3;
/** Rows a frame takes: top and bottom border. */
const FRAME_ROWS = 2;

function slot(id: string, rect: Rect): PaneSlot {
  return {
    id,
    rect,
    header: { x: rect.x, y: rect.y, w: rect.w, h: 1 },
    footer: { x: rect.x, y: rect.y + Math.max(1, rect.h - 1), w: rect.w, h: 1 },
    body: {
      x: rect.x + 1,
      y: rect.y + 1,
      w: Math.max(0, rect.w - 2),
      h: Math.max(0, rect.h - FRAME_ROWS),
    },
  };
}

/** Split `total` into `n` parts, giving the remainder to the first parts. */
export function split(total: number, n: number): number[] {
  const base = Math.floor(total / n);
  const extra = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * Main takes the left half (top half on narrow terminals). Up to
 * `visibleForks` forks stack in the other half; the rest stay running as
 * status-bar tabs. A focused hidden fork swaps into the last visible slot.
 */
export function computeLayout(l: LayoutInput): Layout {
  const cols = Math.max(20, l.cols);
  const rows = Math.max(6, l.rows);
  const status: Rect = { x: 0, y: rows - 1, w: cols, h: 1 };
  const area: Rect = { x: 0, y: 0, w: cols, h: rows - 1 };
  const [main, ...forks] = l.ids;
  if (!main) return { panes: [], hidden: [], status, orientation: 'single' };

  if (l.zoom && l.ids.includes(l.zoom)) {
    return {
      panes: [slot(l.zoom, area)],
      hidden: l.ids.filter((id) => id !== l.zoom),
      status,
      orientation: 'single',
    };
  }
  if (!forks.length)
    return { panes: [slot(main, area)], hidden: [], status, orientation: 'single' };

  const side = cols >= l.splitColumns;
  const forkSpace = side ? area.h : area.h - Math.ceil(area.h / 2);
  const maxByHeight = Math.max(1, Math.floor(forkSpace / (MIN_BODY + FRAME_ROWS)));
  let visible = forks.slice(0, Math.min(Math.max(1, l.visibleForks), maxByHeight));
  if (l.focus && forks.includes(l.focus) && !visible.includes(l.focus)) {
    visible = [...visible.slice(0, -1), l.focus];
  }
  const hidden = forks.filter((f) => !visible.includes(f));
  const panes: PaneSlot[] = [];

  // Frames sit edge to edge, so no divider is needed between them.
  if (side) {
    const mainW = Math.floor(cols / 2);
    panes.push(slot(main, { x: 0, y: 0, w: mainW, h: area.h }));
    const forkX = mainW;
    const heights = split(area.h, visible.length);
    let y = 0;
    visible.forEach((id, i) => {
      panes.push(slot(id, { x: forkX, y, w: cols - forkX, h: heights[i]! }));
      y += heights[i]!;
    });
  } else {
    const mainH = Math.ceil(area.h / 2);
    panes.push(slot(main, { x: 0, y: 0, w: cols, h: mainH }));
    const heights = split(area.h - mainH, visible.length);
    let y = mainH;
    visible.forEach((id, i) => {
      panes.push(slot(id, { x: 0, y, w: cols, h: heights[i]! }));
      y += heights[i]!;
    });
  }
  return { panes, hidden, status, orientation: side ? 'side' : 'stacked' };
}
