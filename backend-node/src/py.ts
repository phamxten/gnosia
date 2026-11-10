/* Python semantics the ported code relies on. JS differs on all of these:
   round() is half-even, int() truncates and rejects junk, empty containers are falsy,
   dict.get only falls back when the key is missing, and slices count code points. */

export type Json = any;

/** round(x) / round(x, nd): round half to even. */
export function pyRound(x: number, nd = 0): number {
  const m = 10 ** nd;
  const y = x * m;
  let r = Math.round(y);
  if (Math.abs(y % 1) === 0.5) r = 2 * Math.round(y / 2);
  return nd ? r / m : r + 0; // + 0 turns -0 into 0
}

/** f"{x:.0f}" */
export function fmt0(x: number): string {
  return String(pyRound(Number(x)));
}

/** str(float): 4.0 prints as "4.0" */
export function floatStr(x: number): string {
  return Number.isInteger(x) ? x.toFixed(1) : String(x);
}

/** int(v) on a JSON value; throws like Python's ValueError/TypeError. */
export function pyInt(v: Json): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return parseInt(v, 10);
  throw new TypeError(`invalid literal for int(): ${JSON.stringify(v)}`);
}

/** int(v) or None */
export function asInt(v: Json): number | null {
  try { return pyInt(v); } catch { return null; }
}

/** isinstance(v, int) (bool is an int in Python) */
export function isInt(v: Json): v is number {
  return typeof v === 'boolean' || (typeof v === 'number' && Number.isInteger(v));
}

/** bool(v) */
export function truthy(v: Json): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '' || Number.isNaN(v)) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object' && !(v instanceof Date)) return Object.keys(v).length > 0;
  return true;
}

/** a or b */
export function or<A, B>(a: A, b: B): A | B {
  return truthy(a) ? a : b;
}

/** d.get(k, default) */
export function get(d: Json, k: string, def: Json = null): Json {
  return d !== null && typeof d === 'object' && Object.hasOwn(d, k) ? d[k] : def;
}

/** s[:n] (code points, not UTF-16 units) */
export function cut(s: string, n: number): string {
  return s.length <= n ? s : Array.from(s).slice(0, n).join('');
}

/** s.split() */
export function words(s: string): string[] {
  const t = s.trim();
  return t ? t.split(/\s+/) : [];
}

/** s.split()[0] (Python raises on an empty name; "" is kinder) */
export function first(s: string): string {
  return words(s)[0] ?? '';
}

export function sum(xs: Iterable<number>): number {
  let t = 0;
  for (const x of xs) t += x;
  return t;
}

/** html.escape(s) */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

/** re.escape for a pattern compiled with the u flag */
export function reEscape(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/** Python's \w and \b are Unicode-aware; JS's are ASCII. */
export const W = '[\\p{L}\\p{N}_]';
/** Python's \b (use with the u flag) */
export const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;

/** list(v): a string becomes its characters, a dict its keys */
export function pyList(v: Json): Json[] {
  if (Array.isArray(v)) return [...v];
  if (typeof v === 'string') return Array.from(v);
  if (v !== null && typeof v === 'object') return Object.keys(v);
  throw new TypeError(`'${typeof v}' object is not iterable`);
}

/** str(v) for a JSON scalar */
export function pyStr(v: Json): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'number') return String(v);
  return repr(v);
}

/** repr(x) for equality checks between JSON values */
export function repr(x: Json): string {
  return JSON.stringify(x) ?? 'None';
}

/** Python == between JSON values (dict order does not matter) */
export function deepEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  const scalar = (x: Json) => typeof x === 'boolean' || typeof x === 'number';
  if (scalar(a) && scalar(b)) return Number(a) === Number(b); // True == 1
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every(k => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

/** copy.deepcopy for JSON values */
export function clone<T>(x: T): T {
  return x === undefined ? x : JSON.parse(JSON.stringify(x));
}

/** sorted(xs, key=...) where key returns a tuple of numbers */
export function sortBy<T>(xs: T[], key: (x: T) => number[]): T[] {
  return [...xs].sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  });
}

/** Counter.most_common(1)[0][0]: first key with the highest count */
export function mostCommon<K>(counts: Map<K, number>): K | undefined {
  let best: K | undefined, bestN = -Infinity;
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
  return best;
}

/** random.shuffle (in place) */
export function shuffle<T>(xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}

/** random.sample(xs, k) */
export function sample<T>(xs: T[], k: number): T[] {
  return shuffle([...xs]).slice(0, k);
}
