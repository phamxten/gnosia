/* Rule-based diagnostics: turns a deterministic error (L1) into a plain-language explanation (L2)
   and, where it is safe, a one-click fix. Never a chatbot (CONCEPT §4). Unknown errors return
   `available: false` so the UI shows "Penjelasan belum tersedia" while the raw error (L1) stays visible. */
import { B, escapeHtml, get, type Json, reEscape, W } from '../util.ts';

const CONSOLE_METHODS = ['log', 'error', 'warn'];
const NAME = `[A-Za-z_$](?:${W}|\\$)*`; // [A-Za-z_$][\w$]* with a Unicode-aware \w

const m = (s: string) => `<span class="t-mono">${escapeHtml(s)}</span>`;
const re = (src: string, flags = '') => new RegExp(src, `u${flags}`);

export function levenshtein(a: string, b: string): number {
  const A = Array.from(a), Bs = Array.from(b);
  let prev = Array.from({ length: Bs.length + 1 }, (_, j) => j);
  for (let i = 1; i <= A.length; i++) {
    const cur = [i];
    for (let j = 1; j <= Bs.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] !== Bs[j - 1] ? 1 : 0)));
    prev = cur;
  }
  return prev[prev.length - 1];
}

export function declaredNames(code: string): string[] {
  const names = [
    ...Array.from(code.matchAll(re(`${B}(?:let|const|var|function)\\s+(${NAME})`, 'g')), x => x[1]),
    ...Array.from(code.matchAll(re(`${B}for\\s*\\(\\s*(?:let|const|var)\\s+(${NAME})`, 'g')), x => x[1]),
  ];
  return [...new Set(names)];
}

export function nearest(name: string, candidates: string[], maxDist = 2): string | null {
  let best: string | null = null, bestD = maxDist + 1;
  for (const c of candidates) {
    const d = levenshtein(name.toLowerCase(), c.toLowerCase());
    if (d < bestD && c !== name) { best = c; bestD = d; }
  }
  return best;
}

function findLine(lines: string[], token: string, fallback: number | null): number | null {
  const pat = re(`${B}${reEscape(token)}${B}`);
  for (let i = 0; i < lines.length; i++) if (pat.test(lines[i]) && !lines[i].trim().startsWith('//')) return i + 1;
  return fallback;
}

export function diagnose(code: string, error: Json, scopeCode = '', assistCap = 6): Json {
  if (assistCap < 2) return { available: false, reason: 'capped' };
  const name = String(get(error, 'name', '') ?? ''), msg = String(get(error, 'message', '') ?? '');
  const line = get(error, 'line');
  const lines = code.split('\n');

  let mt = msg.match(re(`^(${W}(?:${W}|\\$)*) is not defined`));
  if (name === 'ReferenceError' && mt) {
    const missing = mt[1];
    const guess = nearest(missing, declaredNames(`${scopeCode}\n${code}`));
    if (guess) {
      const fixed = code.replace(re(`${B}${reEscape(missing)}${B}`, 'g'), () => guess);
      return {
        available: true, level: 2,
        text: `Variabel ${m(missing)} belum pernah dibuat, jadi JavaScript tidak tahu isinya. Mungkin maksudmu ${m(guess)}?`,
        fix: { label: `Perbaiki jadi ${guess}`, code: fixed },
        line: findLine(lines, missing, line),
      };
    }
    return {
      available: true, level: 2,
      text: `Variabel ${m(missing)} belum pernah dibuat. Buat dulu dengan ${m('let')} atau ${m('const')} sebelum dipakai.`,
      line: findLine(lines, missing, line),
    };
  }

  if (name === 'TypeError' && msg.includes('constant variable')) {
    let target: string | null = null;
    const consts = Array.from(code.matchAll(re(`${B}const\\s+(${NAME})`, 'g')), x => x[1]);
    const bad = line;
    if (typeof bad === 'number' && bad >= 1 && bad <= lines.length) {
      const mm = lines[bad - 1].match(re(`^\\s*(${NAME})\\s*(?:[+\\-*/]?=)(?!=)`));
      target = mm && consts.includes(mm[1]) ? mm[1] : null;
    }
    target = target || (consts.length ? consts[0] : null);
    const out: Json = {
      available: true, level: 2,
      text: `Baris ${bad || '?'} mengganti isi ${m(target || 'const')}, padahal kotak itu dibuat dengan ${m('const')} (digembok). `
        + `Kalau nilainya memang perlu berubah, buat dengan ${m('let')}.`,
      line: bad,
    };
    if (target) out.fix = { label: `Ubah jadi let ${target}`, code: code.replace(re(`${B}const(\\s+${reEscape(target)}${B})`), (_, g1) => `let${g1}`) };
    return out;
  }

  mt = msg.match(/^(.+?) is not a function/u);
  if (name === 'TypeError' && mt) {
    const what = mt[1];
    const method = what.split('.').pop()!;
    const guess = what.startsWith('console.') ? nearest(method, CONSOLE_METHODS) : null;
    const text = `${m(what)} bukan fungsi, jadi tidak bisa dipanggil dengan tanda kurung.`;
    const out: Json = { available: true, level: 2, text: text + (guess ? ` Mungkin maksudmu ${m('console.' + guess)}?` : ' Cek lagi ejaannya.'), line };
    if (guess) out.fix = { label: `Perbaiki jadi console.${guess}`, code: code.replace(re(`console\\.${reEscape(method)}${B}`, 'g'), () => `console.${guess}`) };
    return out;
  }

  if (name === 'TypeError' && msg.includes('Cannot read properties of undefined')) {
    return { available: true, level: 2, line, text: `Kamu mengambil isi dari sesuatu yang masih ${m('undefined')}. Pastikan variabelnya sudah diberi nilai sebelum dipakai.` };
  }

  if (name === 'SyntaxError') {
    let text: string;
    if (msg.includes('missing ) after argument list')) text = `Ada kurung ${m('(')} yang belum ditutup, atau tanda koma/kutip yang hilang di dalamnya.`;
    else if (msg.includes('Invalid or unexpected token')) text = `Ada teks yang tidak dikenali. Biasanya tanda kutip ${m('"')} yang belum ditutup.`;
    else if (msg.includes('Unexpected end of input')) text = `Program berhenti di tengah jalan. Mungkin ada ${m('{')} atau ${m('(')} yang belum ditutup.`;
    else if (msg.includes('Unexpected identifier') || msg.includes('Unexpected token')) text = 'JavaScript menemukan sesuatu di tempat yang tidak ia duga. Cek urutan kata di baris itu, misalnya kata kunci, nama, lalu tanda =.';
    else if (msg.includes('has already been declared')) {
      const nm = msg.match(/^Identifier '(.+)' has already been declared/u);
      text = `Variabel ${m(nm ? nm[1] : '?')} dibuat dua kali. Untuk mengganti isinya, tulis tanpa ${m('let')}/${m('const')}.`;
    } else return { available: false, reason: 'unknown' };
    return { available: true, level: 2, text, line };
  }

  if (name === 'TimeoutError') {
    return { available: true, level: 2, line: null, text: 'Programmu tidak berhenti. Biasanya karena perulangan yang syaratnya selalu benar. Cek variabel yang seharusnya berubah di dalam loop.' };
  }

  return { available: false, reason: 'unknown' };
}
