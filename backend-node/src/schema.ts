/* Database tables (Drizzle MySQL / MariaDB). schema.sql is the matching DDL that initDb() runs on an empty database.

   Chapter content (scenes, exercises, quiz bank, exam, challenge) is stored as a versioned JSON
   document: `chapters.draft` is what the Builder edits, and each publish snapshots it into
   `chapter_versions`. Learners always read a published version, and every attempt records which
   version it was made against.

   Defaults live here ($defaultFn), not in the database. */
import { boolean, customType, date, datetime, int, mysqlTable, text, varchar } from 'drizzle-orm/mysql-core';

const now = () => new Date();
const id = () => int('id').autoincrement().primaryKey();
const ts = (name: string) => datetime(name, { mode: 'date', fsp: 3 }); // UTC, stored in DATETIME(3) without zone shifts
const str = (name: string, length: number) => varchar(name, { length });

/** Consistent JSON column across both MySQL 8 (native JSON wire type) and Hostinger MariaDB (LONGTEXT utf8mb4_bin). */
const json = <T = any>(name: string) =>
  customType<{ data: T; driverData: string }>({
    dataType: () => 'json',
    toDriver: (v: T) => JSON.stringify(v),
    fromDriver: (v: unknown): T => {
      if (v === null || v === undefined) return v as T;
      if (Buffer.isBuffer(v)) return JSON.parse(v.toString('utf8')) as T;
      if (typeof v === 'string') return JSON.parse(v) as T;
      return v as T;
    },
  })(name);

// ---------------------------------------------------------------- people ---
export const organizations = mysqlTable('organizations', {
  id: id(),
  name: str('name', 160).notNull(),
});

/** A school class (e.g. "XII RPL") with its mentor. */
export const classes = mysqlTable('classes', {
  id: id(),
  org_id: int('org_id').notNull(),
  name: str('name', 80).notNull(),
  path_id: int('path_id'),
  mentor_id: int('mentor_id'),
  started_on: date('started_on', { mode: 'string' }),
});

export const users = mysqlTable('users', {
  id: id(),
  email: str('email', 200).notNull(),
  name: str('name', 120).notNull(),
  password_hash: str('password_hash', 200).notNull(),
  role: str('role', 16).notNull().$defaultFn(() => 'learner'), // learner | mentor | admin
  org_id: int('org_id'),
  class_id: int('class_id'),
  avatar: str('avatar', 4).notNull().$defaultFn(() => ''), // "", a2..a5 (colour class)
  title: str('title', 120).notNull().$defaultFn(() => ''), // staff subtitle, e.g. "Kurikulum · SMK SIG"
  onboarded: boolean('onboarded').notNull().$defaultFn(() => false),
  goal: str('goal', 40).notNull().$defaultFn(() => ''),
  daily_goal_min: int('daily_goal_min').notNull().$defaultFn(() => 20),
  assist_cap: int('assist_cap').notNull().$defaultFn(() => 6), // mentor-set hint cap for Perkuat / Playground
  prefs: json<Record<string, any>>('prefs').notNull().$defaultFn(() => ({})), // nosi, reminders, mentor_sees_wrong, language
  created_at: ts('created_at').notNull().$defaultFn(now),
  last_active_at: ts('last_active_at'),
});

// --------------------------------------------------------------- content ---
export const paths = mysqlTable('paths', {
  id: id(),
  slug: str('slug', 60).notNull(),
  title: str('title', 120).notNull(),
  description: text('description').notNull().$defaultFn(() => ''),
});

export const chapters = mysqlTable('chapters', {
  id: id(),
  path_id: int('path_id').notNull(),
  position: int('position').notNull(), // order on the map (1-based)
  number: int('number').notNull().$defaultFn(() => 0), // "Bab N" (learning chapters only; 0 for project/final)
  kind: str('kind', 16).notNull().$defaultFn(() => 'chapter'), // chapter | project | final
  slug: str('slug', 60).notNull(),
  title: str('title', 120).notNull(),
  subtitle: str('subtitle', 160).notNull().$defaultFn(() => ''),
  description: text('description').notNull().$defaultFn(() => ''),
  icon: str('icon', 40).notNull().$defaultFn(() => 'box'),
  module_label: str('module_label', 80).notNull().$defaultFn(() => ''),
  map_x: int('map_x').notNull().$defaultFn(() => 50), // % across the map canvas
  project_id: int('project_id'),
  status: str('status', 16).notNull().$defaultFn(() => 'draft'), // draft | review | published
  version: int('version').notNull().$defaultFn(() => 0), // latest published version (0 = never)
  draft: json<any>('draft').notNull().$defaultFn(() => ({})),
  draft_saved_at: ts('draft_saved_at'),
  updated_at: ts('updated_at').notNull().$defaultFn(now),
  updated_by: int('updated_by'),
});

export const chapter_versions = mysqlTable('chapter_versions', {
  id: id(),
  chapter_id: int('chapter_id').notNull(),
  version: int('version').notNull(),
  content: json<any>('content').notNull(),
  published_at: ts('published_at').notNull().$defaultFn(now),
  published_by: int('published_by'),
});

/** A learnable idea. Positions (x, y) place it on the Progres constellation. */
export const concepts = mysqlTable('concepts', {
  id: id(),
  path_id: int('path_id').notNull(),
  key: str('key', 60).notNull(),
  name: str('name', 80).notNull(), // short label on the constellation, e.g. "salinan nilai"
  skill: str('skill', 120).notNull().$defaultFn(() => ''), // sentence on the chapter page, e.g. "Membuat variabel"
  chapter_id: int('chapter_id'),
  x: int('x').notNull().$defaultFn(() => 0),
  y: int('y').notNull().$defaultFn(() => 0),
  requires: json<string[]>('requires').notNull().$defaultFn(() => []), // prerequisite concept keys
});

export const projects = mysqlTable('projects', {
  id: id(),
  path_id: int('path_id').notNull(),
  slug: str('slug', 60).notNull(),
  title: str('title', 120).notNull(),
  number: int('number').notNull().$defaultFn(() => 1),
  unlock_after: int('unlock_after').notNull().$defaultFn(() => 2), // "Bab N" that must be done first
  description: text('description').notNull().$defaultFn(() => ''),
  milestones: json<any[]>('milestones').notNull().$defaultFn(() => []),
});

// -------------------------------------------------------------- progress ---
export const chapter_progress = mysqlTable('chapter_progress', {
  id: id(),
  user_id: int('user_id').notNull(),
  chapter_id: int('chapter_id').notNull(),
  version: int('version').notNull().$defaultFn(() => 1), // content version this learner is on
  phases: json<Record<string, any>>('phases').notNull(), // {pahami:{state,progress,score?}, ...}
  current: str('current', 12).notNull().$defaultFn(() => 'pahami'),
  started_at: ts('started_at').notNull().$defaultFn(now),
  updated_at: ts('updated_at').notNull().$defaultFn(now),
  completed_at: ts('completed_at'),
  phase_since: ts('phase_since').notNull().$defaultFn(now), // when `current` started
  active_seconds: int('active_seconds').notNull().$defaultFn(() => 0), // time spent in the player for this chapter
});

/** Resumable player state per learner, chapter and phase (scene index, answers, hints...). */
export const player_states = mysqlTable('player_states', {
  id: id(),
  user_id: int('user_id').notNull(),
  chapter_id: int('chapter_id').notNull(),
  phase: str('phase', 16).notNull(), // pahami | perkuat | mini | challenge
  data: json<Record<string, any>>('data').notNull().$defaultFn(() => ({})),
  updated_at: ts('updated_at').notNull().$defaultFn(now),
});

export const attempts = mysqlTable('attempts', {
  id: id(),
  user_id: int('user_id').notNull(),
  chapter_id: int('chapter_id').notNull(),
  phase: str('phase', 12).notNull(), // perkuat | kuis | ulangan | challenge
  item_id: str('item_id', 40).notNull(),
  attempt_no: int('attempt_no').notNull().$defaultFn(() => 1),
  correct: boolean('correct').notNull(),
  answer: json<any>('answer'),
  hint_level: int('hint_level').notNull().$defaultFn(() => 0),
  ms: int('ms').notNull().$defaultFn(() => 0),
  version: int('version').notNull().$defaultFn(() => 1),
  created_at: ts('created_at').notNull().$defaultFn(now),
});

export const hint_opens = mysqlTable('hint_opens', {
  id: id(),
  user_id: int('user_id').notNull(),
  chapter_id: int('chapter_id').notNull(),
  item_id: str('item_id', 40).notNull(),
  level: int('level').notNull(),
  ms_since_shown: int('ms_since_shown').notNull().$defaultFn(() => 0),
  created_at: ts('created_at').notNull().$defaultFn(now),
});

export const concept_mastery = mysqlTable('concept_mastery', {
  id: id(),
  user_id: int('user_id').notNull(),
  concept_id: int('concept_id').notNull(),
  tier: int('tier').notNull().$defaultFn(() => 0), // 0..5
  weak: boolean('weak').notNull().$defaultFn(() => false),
  weak_phase: str('weak_phase', 12).notNull().$defaultFn(() => ''), // where it went wrong
  weak_note: text('weak_note').notNull().$defaultFn(() => ''), // "Kamu menjawab 5, seharusnya 2."
  last_evidence: str('last_evidence', 200).notNull().$defaultFn(() => ''),
  updated_at: ts('updated_at').notNull().$defaultFn(now),
});

/** Average mastery (%) per learner per week, for the Progres trend chart. */
export const mastery_snapshots = mysqlTable('mastery_snapshots', {
  id: id(),
  user_id: int('user_id').notNull(),
  week_start: date('week_start', { mode: 'string' }).notNull(),
  pct: int('pct').notNull(),
});

export const xp_events = mysqlTable('xp_events', {
  id: id(),
  user_id: int('user_id').notNull(),
  amount: int('amount').notNull(),
  reason: str('reason', 80).notNull(),
  created_at: ts('created_at').notNull().$defaultFn(now),
});

export const daily_activity = mysqlTable('daily_activity', {
  id: id(),
  user_id: int('user_id').notNull(),
  day: date('day', { mode: 'string' }).notNull(),
  seconds: int('seconds').notNull().$defaultFn(() => 0),
});

export const quiz_rounds = mysqlTable('quiz_rounds', {
  id: id(),
  user_id: int('user_id').notNull(),
  chapter_id: int('chapter_id'),
  kind: str('kind', 12).notNull().$defaultFn(() => 'gate'), // gate | daily | review
  version: int('version').notNull().$defaultFn(() => 1),
  question_refs: json<[number, string][]>('question_refs').notNull(), // [[chapter_id, question_id], ...]
  answers: json<any[]>('answers').notNull().$defaultFn(() => []), // [{choice, correct, left, points}]
  per_question_sec: int('per_question_sec').notNull().$defaultFn(() => 20),
  score: int('score').notNull().$defaultFn(() => 0),
  combo: int('combo').notNull().$defaultFn(() => 1),
  best_combo: int('best_combo').notNull().$defaultFn(() => 1),
  finished: boolean('finished').notNull().$defaultFn(() => false),
  pct: int('pct'),
  passed: boolean('passed'),
  created_at: ts('created_at').notNull().$defaultFn(now),
});

export const exam_sessions = mysqlTable('exam_sessions', {
  id: id(),
  user_id: int('user_id').notNull(),
  chapter_id: int('chapter_id').notNull(),
  version: int('version').notNull().$defaultFn(() => 1),
  started_at: ts('started_at').notNull().$defaultFn(now),
  deadline: ts('deadline').notNull(),
  answers: json<Record<string, any>>('answers').notNull().$defaultFn(() => ({})), // {question_id: answer}
  flags: json<string[]>('flags').notNull().$defaultFn(() => []),
  submitted_at: ts('submitted_at'),
  score: int('score'),
  passed: boolean('passed'),
  results: json<any[] | null>('results'),
});

/** Code sent for mentor review: a passed Challenge or a project milestone. */
export const submissions = mysqlTable('submissions', {
  id: id(),
  user_id: int('user_id').notNull(),
  kind: str('kind', 12).notNull(), // challenge | milestone
  chapter_id: int('chapter_id'),
  project_id: int('project_id'),
  milestone: int('milestone'),
  title: str('title', 160).notNull().$defaultFn(() => ''),
  filename: str('filename', 80).notNull().$defaultFn(() => 'main.js'),
  code: text('code').notNull(),
  attempt_no: int('attempt_no').notNull().$defaultFn(() => 1),
  tests_passed: int('tests_passed').notNull().$defaultFn(() => 0),
  tests_total: int('tests_total').notNull().$defaultFn(() => 0),
  error_line: int('error_line'),
  status: str('status', 12).notNull().$defaultFn(() => 'pending'), // pending | changes | approved
  summary: text('summary').notNull().$defaultFn(() => ''),
  reviewed_by: int('reviewed_by'),
  reviewed_at: ts('reviewed_at'),
  seen_by_learner: boolean('seen_by_learner').notNull().$defaultFn(() => true),
  created_at: ts('created_at').notNull().$defaultFn(now),
});

export const review_comments = mysqlTable('review_comments', {
  id: id(),
  submission_id: int('submission_id').notNull(),
  author_id: int('author_id').notNull(),
  line: int('line').notNull(),
  body: text('body').notNull(),
  created_at: ts('created_at').notNull().$defaultFn(now),
});

export const project_progress = mysqlTable('project_progress', {
  id: id(),
  user_id: int('user_id').notNull(),
  project_id: int('project_id').notNull(),
  milestone: int('milestone').notNull().$defaultFn(() => 0), // index of the current milestone
  code: text('code').notNull().$defaultFn(() => ''),
  status: str('status', 12).notNull().$defaultFn(() => 'work'), // work | waiting | feedback | portfolio
  last_run: json<any>('last_run'), // {results: [...], logs, error} of the latest run
  published_at: ts('published_at'),
  updated_at: ts('updated_at').notNull().$defaultFn(now),
});

/** Learner ↔ mentor thread (per learner; optionally tied to a project). */
export const messages = mysqlTable('messages', {
  id: id(),
  learner_id: int('learner_id').notNull(),
  author_id: int('author_id').notNull(),
  project_id: int('project_id'),
  context: str('context', 160).notNull().$defaultFn(() => ''), // "Challenge Papan Skor"
  body: text('body').notNull(),
  read: boolean('read').notNull().$defaultFn(() => false),
  created_at: ts('created_at').notNull().$defaultFn(now),
});

export const notebooks = mysqlTable('notebooks', {
  id: id(),
  user_id: int('user_id').notNull(),
  title: str('title', 160).notNull().$defaultFn(() => 'Notebook tanpa judul'),
  attached_chapter_id: int('attached_chapter_id'),
  cells: json<any[]>('cells').notNull().$defaultFn(() => []), // [{id, type: code|note, src}]
  created_at: ts('created_at').notNull().$defaultFn(now),
  updated_at: ts('updated_at').notNull().$defaultFn(now),
});

/** Mentor-assigned work: a Pahami scene and/or a few Perkuat items. */
export const assignments = mysqlTable('assignments', {
  id: id(),
  mentor_id: int('mentor_id').notNull(),
  learner_id: int('learner_id').notNull(),
  chapter_id: int('chapter_id'),
  title: str('title', 200).notNull(),
  link: str('link', 200).notNull().$defaultFn(() => ''),
  done: boolean('done').notNull().$defaultFn(() => false),
  created_at: ts('created_at').notNull().$defaultFn(now),
});

export const notifications = mysqlTable('notifications', {
  id: id(),
  user_id: int('user_id').notNull(),
  kind: str('kind', 24).notNull(),
  title: str('title', 200).notNull(),
  body: text('body').notNull().$defaultFn(() => ''),
  link: str('link', 200).notNull().$defaultFn(() => ''),
  read: boolean('read').notNull().$defaultFn(() => false),
  created_at: ts('created_at').notNull().$defaultFn(now),
});

/** A learner report such as "output benar tapi gagal" on a challenge test. */
export const content_reports = mysqlTable('content_reports', {
  id: id(),
  user_id: int('user_id').notNull(),
  chapter_id: int('chapter_id').notNull(),
  item_id: str('item_id', 40).notNull(),
  body: text('body').notNull().$defaultFn(() => ''),
  created_at: ts('created_at').notNull().$defaultFn(now),
});

export type User = typeof users.$inferSelect;
export type Klass = typeof classes.$inferSelect;
export type Path = typeof paths.$inferSelect;
export type Chapter = typeof chapters.$inferSelect;
export type Concept = typeof concepts.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type ChapterProgress = typeof chapter_progress.$inferSelect;
export type PlayerState = typeof player_states.$inferSelect;
export type Attempt = typeof attempts.$inferSelect;
export type ConceptMastery = typeof concept_mastery.$inferSelect;
export type QuizRound = typeof quiz_rounds.$inferSelect;
export type ExamSession = typeof exam_sessions.$inferSelect;
export type Submission = typeof submissions.$inferSelect;
export type ProjectProgress = typeof project_progress.$inferSelect;
export type Notebook = typeof notebooks.$inferSelect;
export type HintOpen = typeof hint_opens.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
