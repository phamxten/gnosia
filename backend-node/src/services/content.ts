/* Chapter content documents: loading published versions, hiding answer keys from learners,
   and checking answers server-side.

   Content shape (one JSON document per chapter version):

    {
      "minutes": {"pahami": 6, "perkuat": 8, ...},
      "concepts": ["let", "const", ...],
      "cheatsheet": "let skor = 10;  // ...",
      "pahami":  {"scenes":  [Scene, ...]},
      "perkuat": {"items":   [Exercise, ...]},
      "kuis":    {"round_size": 10, "seconds": 20, "pass_pct": 70, "combo_max": 3, "bank": [Question, ...]},
      "ulangan": {"minutes": 30, "pass_mark": 75, "questions": [ExamQuestion, ...]},
      "challenge": {"title", "story", "steps", "starter", "filename", "tests": [Test, ...], ...},
      "uji_mode": "any" | "ulangan" | "challenge"
    }
*/
import { Db, eq, first, T, where } from '../db.ts';
import { asInt, clone as deepClone, deepEqual, get, type Json, or, toList, toStr, truthy } from '../util.ts';
import type { Chapter } from '../schema.ts';

export async function published(db: Db, chapter: Chapter, version: number | null = null): Promise<Json | null> {
  const v = version || chapter.version;
  if (!v) return null;
  const row = await first(db, T.chapter_versions, where(eq(T.chapter_versions.chapter_id, chapter.id), eq(T.chapter_versions.version, v)));
  if (!row && version) return published(db, chapter);
  return row ? row.content : null;
}

export function emptyContent(): Json {
  return {
    minutes: { pahami: 6, perkuat: 8, kuis: 4, uji: 10 },
    concepts: [],
    cheatsheet: '',
    pahami: { scenes: [] },
    perkuat: { items: [] },
    kuis: { round_size: 10, seconds: 20, pass_pct: 70, combo_max: 3, bank: [] },
    ulangan: { minutes: 30, pass_mark: 75, questions: [] },
    challenge: null,
    uji_mode: 'any',
  };
}

// ------------------------------------------------------------- learner views
export function perkuatItemPublic(item: Json): Json {
  const out: Json = Object.fromEntries(Object.entries(item).filter(([k]) => !['answer', 'hints', 'explain', 'l6'].includes(k)));
  out.has_hints = ['l3', 'l4', 'l5'].filter(lvl => truthy(get(or(get(item, 'hints'), {}), lvl)));
  out.has_solution = truthy(get(item, 'l6'));
  return out;
}

const pick = (q: Json, keys: string[]) => Object.fromEntries(keys.filter(k => Object.hasOwn(q, k)).map(k => [k, q[k]]));

export function kuisQuestionPublic(q: Json): Json {
  return pick(q, ['id', 't', 'c', 'o', 'trivia']);
}

export function examQuestionPublic(q: Json): Json {
  return pick(q, ['id', 't', 'code', 'type', 'o', 'pts', 'pre', 'label']);
}

export function challengePublic(ch: Json): Json {
  const out: Json = Object.fromEntries(Object.entries(ch).filter(([k]) => k !== 'tests'));
  out.tests = get(ch, 'tests', []).map((t: Json) => ({
    id: t.id, name: truthy(get(t, 'hidden')) ? 'Tes tersembunyi' : t.name, hidden: truthy(get(t, 'hidden')),
  }));
  return out;
}

export function find(items: Json[], itemId: unknown): Json | null {
  return items.find(i => deepEqual(get(i, 'id'), itemId)) ?? null;
}

// ------------------------------------------------------------- answer checks
/** Returns [correct, marks]. `marks` tells the UI which parts to outline. */
export function checkPerkuat(item: Json, answer: Json): [boolean, Json] {
  const t = item.type;
  const key = get(item, 'answer');
  if (t === 'choice' || t === 'predict' || t === 'bug') {
    const ok = asInt(answer) === key;
    return [ok, { picked: asInt(answer), ok }];
  }
  if (t === 'fill') {
    const got = toList(or(answer, []));
    const marks = toList(key).map((exp, i) => i < got.length && deepEqual(got[i], exp));
    return [marks.every(Boolean) && got.length === toList(key).length, marks];
  }
  if (t === 'parsons') {
    const got = toList(or(answer, [])).map(toStr);
    const k = toList(key);
    const marks = got.map((g, i) => i < k.length && g === toStr(k[i]));
    return [deepEqual(got, k.map(toStr)), marks];
  }
  if (t === 'slider') {
    const ok = asInt(answer) === key;
    return [ok, { ok }];
  }
  if (t === 'match') {
    const pairs = toList(or(answer, []));
    const left = new Set(get(item, 'left', []).map((p: Json) => JSON.stringify(p.key)));
    const ok = pairs.length === left.size && pairs.every(p => Array.isArray(p) && p.length === 2 && deepEqual(p[0], p[1]));
    return [ok, { ok }];
  }
  throw new Error(`tipe soal tidak dikenal: ${t}`);
}

/** Checks choice/short questions. Returns null for code questions (run by the sandbox). */
export function checkExamStatic(q: Json, answer: Json): boolean | null {
  if (answer === null || answer === undefined || answer === '') return false;
  if (q.type === 'choice') return asInt(answer) === get(q, 'answer');
  if (q.type === 'short') {
    const norm = toStr(answer).trim().replace(/;+$/, '').trim().toLowerCase();
    return get(q, 'accept', []).map((a: string) => a.toLowerCase()).includes(norm);
  }
  return null;
}

export function itemConcepts(content: Json, phase: string, itemId: string): string[] {
  const pools: Record<string, Json[]> = {
    perkuat: get(get(content, 'perkuat', {}), 'items', []),
    kuis: get(get(content, 'kuis', {}), 'bank', []),
    ulangan: get(get(content, 'ulangan', {}), 'questions', []),
  };
  const it = find(pools[phase] ?? [], itemId);
  return [...get(or(it, {}), 'concepts', [])];
}

export function phaseCounts(content: Json): { scenes: number; items: number; similar: number; bank: number; exam: number } {
  const items: Json[] = get(get(content, 'perkuat', {}), 'items', []);
  return {
    scenes: get(get(content, 'pahami', {}), 'scenes', []).length,
    items: items.filter(i => !truthy(get(i, 'adaptive'))).length,
    similar: items.filter(i => truthy(get(i, 'adaptive'))).length,
    bank: get(get(content, 'kuis', {}), 'bank', []).length,
    exam: get(or(get(content, 'ulangan'), {}), 'questions', []).length,
  };
}

export const clone = deepClone;
