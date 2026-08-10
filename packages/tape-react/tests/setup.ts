/**
 * jsdom gap-fillers, installed before every test file:
 *
 * - ResizeObserver: invokes its callback once, synchronously, on observe()
 *   with the rect currently in globalThis.__tapeObservedRect (tests set it
 *   via helpers.setObservedSize BEFORE mounting).
 * - requestAnimationFrame / cancelAnimationFrame: fully manual — callbacks
 *   queue until helpers.fireAnimationFrames() runs and clears them.
 * - HTMLCanvasElement.getContext('2d'): a recording stub; every method call
 *   is appended to ctx.calls (helpers.recordingCtx reads it back).
 */

export {};

const g = globalThis as unknown as Record<string, unknown>;

// React's act() needs this outside a test-runner-globals environment.
g['IS_REACT_ACT_ENVIRONMENT'] = true;

// ---------------------------------------------------------------------------
// ResizeObserver

interface ObservedRect {
  width: number;
  height: number;
}

g['__tapeObservedRect'] = { width: 800, height: 300 } satisfies ObservedRect;

type RoEntry = {
  target: Element;
  contentRect: {
    width: number;
    height: number;
    x: number;
    y: number;
    top: number;
    left: number;
    right: number;
    bottom: number;
  };
};
type RoCallback = (entries: RoEntry[], observer: unknown) => void;

class StubResizeObserver {
  private readonly cb: RoCallback;

  constructor(cb: RoCallback) {
    this.cb = cb;
  }

  observe(target: Element): void {
    const rect = g['__tapeObservedRect'] as ObservedRect;
    this.cb(
      [
        {
          target,
          contentRect: {
            width: rect.width,
            height: rect.height,
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: rect.width,
            bottom: rect.height,
          },
        },
      ],
      this,
    );
  }

  unobserve(): void {}

  disconnect(): void {}
}

g['ResizeObserver'] = StubResizeObserver;

// ---------------------------------------------------------------------------
// Manual requestAnimationFrame

const rafPending = new Map<number, (now: number) => void>();
let nextRafId = 1;

g['requestAnimationFrame'] = (cb: (now: number) => void): number => {
  const id = nextRafId++;
  rafPending.set(id, cb);
  return id;
};

g['cancelAnimationFrame'] = (id: number): void => {
  rafPending.delete(id);
};

/** Fire (and clear) all currently-pending rAF callbacks. Returns the count. */
g['__tapeFireFrames'] = (now = 0): number => {
  const cbs = Array.from(rafPending.values());
  rafPending.clear();
  for (const cb of cbs) cb(now);
  return cbs.length;
};

g['__tapeRafPending'] = (): number => rafPending.size;

// ---------------------------------------------------------------------------
// Recording Canvas 2D context

const CTX_METHODS = [
  'clearRect',
  'fillRect',
  'strokeRect',
  'beginPath',
  'closePath',
  'moveTo',
  'lineTo',
  'bezierCurveTo',
  'quadraticCurveTo',
  'arc',
  'rect',
  'stroke',
  'fill',
  'clip',
  'fillText',
  'strokeText',
  'save',
  'restore',
  'scale',
  'rotate',
  'translate',
  'transform',
  'setTransform',
  'resetTransform',
  'setLineDash',
  'drawImage',
] as const;

class RecordingContext2D {
  readonly calls: Array<{ op: string; args: unknown[] }> = [];
  readonly canvas: HTMLCanvasElement;
  fillStyle: unknown = '#000000';
  strokeStyle: unknown = '#000000';
  lineWidth = 1;
  font = '';
  textAlign = 'left';
  textBaseline = 'alphabetic';
  globalAlpha = 1;
  lineCap = 'butt';
  lineJoin = 'miter';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    for (const op of CTX_METHODS) {
      Object.defineProperty(this, op, {
        value: (...args: unknown[]) => {
          this.calls.push({ op, args });
          return undefined;
        },
        writable: true,
        configurable: true,
      });
    }
  }

  measureText(text: unknown): { width: number } {
    this.calls.push({ op: 'measureText', args: [text] });
    return { width: String(text).length * 6 };
  }

  callsOf(op: string): Array<{ op: string; args: unknown[] }> {
    return this.calls.filter((c) => c.op === op);
  }
}

(HTMLCanvasElement.prototype as unknown as Record<string, unknown>)[
  'getContext'
] = function getContext(this: HTMLCanvasElement, kind: string) {
  if (kind !== '2d') return null;
  const holder = this as unknown as { __recordingCtx?: RecordingContext2D };
  if (holder.__recordingCtx === undefined) {
    holder.__recordingCtx = new RecordingContext2D(this);
  }
  return holder.__recordingCtx;
};
