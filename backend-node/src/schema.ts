/* Database tables (Drizzle), column for column the same as the SQLAlchemy models the Python backend
   used, so both backends can share one database. schema.sql is the DDL SQLAlchemy emits for them.

   Chapter content (scenes, exercises, quiz bank, exam, challenge) is stored as a versioned JSON
   document: `chapters.draft` is what the Builder edits, and each publish snapshots it into
   `chapter_versions`. Learners always read a published version, and every attempt records which
   version it was made against.

   Defaults live here ($defaultFn), not in the database: SQLAlchemy applied them client-side too. */
import { boolean, date, integer, json, pgTable, serial, text, timestamp, varchar } from 'drizzle-orm/pg-core';

const now = () => new Date();
const ts = (name: string) => timestamp(name, { mode: 'date' }); // UTC, stored without a zone like SQLAlchemy did
const str = (name: string, length: number) => varchar(name, { length });

// ---------------------------------------------------------------- people ---
export const organizations = pgTable('organizations', {
  id: serial('id').primaryKey(),
  name: str('name', 160).notNull(),
});

/** A school class (e.g. "XII RPL") with its mentor. */
export const classes = pgTable('classes', {
  id: serial('id').primaryKey(),
  org_id: integer('org_id').notNull(),
  name: str('name', 80).notNull(),
  path_id: integer('path_id'),
  mentor_id: integer('mentor_id'),
  started_on: date('started_on', { mode: 'string' }),
});

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: str('email', 200).notNull(),
  name: str('name', 120).notNull(),
  password_hash: str('password_hash', 200).notNull(),
  role: str('role', 16).notNull().$defaultFn(() => 'learner'), // learner | mentor | admin
  org_id: integer('org_id'),
  class_id: integer('class_id'),
  avatar: str('avatar', 4).notNull().$defaultFn(() => ''), // "", a2..a5 (colour class)
  title: str('title', 120).notNull().$defaultFn(() => ''), // staff subtitle, e.g. "Kurikulum · SMK SIG"
  onboarded: boolean('onboarded').notNull().$defaultFn(() => false),
  goal: str('goal', 40).notNull().$defaultFn(() => ''),
  daily_goal_min: integer('daily_goal_min').notNull().$defaultFn(() => 20),
  assist_cap: integer('assist_cap').notNull().$defaultFn(() => 6), // mentor-set hint cap for Perkuat / Playground
  prefs: json('prefs').$type<Record<string, any>>().notNull().$defaultFn(() => ({})), // nosi, reminders, mentor_sees_wrong, language
  created_at: ts('created_at').notNull().$defaultFn(now),
  last_active_at: ts('last_active_at'),
});

// --------------------------------------------------------------- content ---
export const paths = pgTable('paths', {
  id: serial('id').primaryKey(),
  slug: str('slug', 60).notNull(),
  title: str('title', 120).notNull(),
  description: text('description').notNull().$defaultFn(() => ''),
});

export const chapters = pgTable('chapters', {
  id: serial('id').primaryKey(),
  path_id: integer('path_id').notNull(),
  position: integer('position').notNull(), // order on the map (1-based)
  number: integer('number').notNull().$defaultFn(() => 0), // "Bab N" (learning chapters only; 0 for project/final)
  kind: str('kind', 16).notNull().$defaultFn(() => 'chapter'), // chapter | project | final
  slug: str('slug', 60).notNull(),
  title: str('title', 120).notNull(),
  subtitle: str('subtitle', 160).notNull().$defaultFn(() => ''),
  description: text('description').notNull().$defaultFn(() => ''),
  icon: str('icon', 40).notNull().$defaultFn(() => 'box'),
  module_label: str('module_label', 80).notNull().$defaultFn(() => ''),
  map_x: integer('map_x').notNull().$defaultFn(() => 50), // % across the map canvas
  project_id: integer('project_id'),
  status: str('status', 16).notNull().$defaultFn(() => 'draft'), // draft | review | published
  version: integer('version').notNull().$defaultFn(() => 0), // latest published version (0 = never)
  draft: json('draft').$type<any>().notNull().$defaultFn(() => ({})),
  draft_saved_at: ts('draft_saved_at'),
  updated_at: ts('updated_at').notNull().$defaultFn(now),
  updated_by: integer('updated_by'),
});

export const chapter_versions = pgTable('chapter_versions', {
  id: serial('id').primaryKey(),
  chapter_id: integer('chapter_id').notNull(),
  version: integer('version').notNull(),
  content: json('content').$type<any>().notNull(),
  published_at: ts('published_at').notNull().$defaultFn(now),
  published_by: integer('published_by'),
});

/** A learnable idea. Positions (x, y) place it on the Progres constellation. */
export const concepts = pgTable('concepts', {
  id: serial('id').primaryKey(),
  path_id: integer('path_id').notNull(),
  key: str('key', 60).notNull(),
  name: str('name', 80).notNull(), // short label on the constellation, e.g. "salinan nilai"
  skill: str('skill', 120).notNull().$defaultFn(() => ''), // sentence on the chapter page, e.g. "Membuat variabel"
  chapter_id: integer('chapter_id'),
  x: integer('x').notNull().$defaultFn(() => 0),
  y: integer('y').notNull().$defaultFn(() => 0),
  requires: json('requires').$type<string[]>().notNull().$defaultFn(() => []), // prerequisite concept keys
});

export const projects = pgTable('projects', {
  id: serial('id').primaryKey(),
  path_id: integer('path_id').notNull(),
  slug: str('slug', 60).notNull(),
  title: str('title', 120).notNull(),
  number: integer('number').notNull().$defaultFn(() => 1),
  unlock_after: integer('unlock_after').notNull().$defaultFn(() => 2), // "Bab N" that must be done first
  description: text('description').notNull().$defaultFn(() => ''),
  milestones: json('milestones').$type<any[]>().notNull().$defaultFn(() => []),
});

// -------------------------------------------------------------- progress ---
export const chapter_progress = pgTable('chapter_progress', {
  id: serial('id').primaryKey(),
  user_id: integer('user_id').notNull(),
  chapter_id: integer('chapter_id').notNull(),
  version: integer('version').notNull().$defaultFn(() => 1), // content version this learner is on
  phases: json('phases').$type<Record<string, any>>().notNull(), // {pahami:{state,progress,score?}, ...}
  current: str('current', 12).notNull().$defaultFn(() => 'pahami'),
  started_at: ts('started_at').notNull().$defaultFn(now),
  updated_at: ts('updated_at').notNull().$defaultFn(now),
  completed_at: ts('completed_at'),
  phase_since: ts('phase_since').notNull().$defaultFn(now), // when `current` started
  active_seconds: integer('active_seconds').notNull().$defaultFn(() => 0), // time spent in the player for this chapter
});

/** Resumable player state per learner, chapter and phase (scene index, answers, hints...). */
export const player_states = pgTable('player_states', {
  id: serial('id').primaryKey(),
  user_id: integer('user_id').notNull(),
  chapter_id: integer('chapter_id').notNull(),
  phase: str('phase', 16).notNull(), // pahami | perkuat | mini | challenge
  data: json('data').$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
  updated_at: ts('updated_at').notNull().$defaultFn(now),
});

export const attempts = pgTable('attempts', {
  id: serial('id').primaryKey(),
  user_id: integer('user_id').notNull(),
  chapter_id: integer('chapter_id').notNull(),
  phase: str('phase', 12).notNull(), // perkuat | kuis | ulangan | challenge
  item_id: str('item_id', 40).notNull(),
  attempt_no: integer('attempt_no').notNull().$defaultFn(() => 1),
  correct: boolean('correct').notNull(),
  answer: json('answer').$type<any>(),
  hint_level: integer('hint_level').notNull().$defaultFn(() => 0),
  ms: integer('ms').notNull().$defaultFn(() => 0),
  version: integer('version').notNull().$defaultFn(() => 1),
  created_at: ts('created_at').notNull().$defaultFn(now),
});

export const hint_opens = pgTable('hint_opens', {
  id: serial('id').primaryKey(),
  user_id: integer('user_id').notNull(),
  chapter_id: integer('chapter_id').notNull(),
  item_id: str('item_id', 40).notNull(),
  level: integer('level').notNull(),
  ms_since_shown: integer('ms_since_shown').notNull().$defaultFn(() => 0),
  created_at: ts('created_at').notNull().$defaultFn(now),
});

export const concept_mastery = pgTable('concept_mastery', {
  id: serial('id').primaryKey(),
  user_id: integer('user_id').notNull(),
  concept_id: integer('concept_id').notNull(),
  tier: integer('tier').notNull().$defaultFn(() => 0), // 0..5
  weak: boolean('weak').notNull().$defaultFn(() => false),
  weak_phase: str('weak_phase', 12).notNull().$defaultFn(() => ''), // where it went wrong
  weak_note: text('weak_note').notNull().$defaultFn(() => ''), // "Kamu menjawab 5, seharusnya 2."
  last_evidence: str('last_evidence', 200).notNull().$defaultFn(() => ''),
  updated_at: ts('updated_at').notNull().$defaultFn(now),
});

/** Average mastery (%) per learner per week, for the Progres trend chart. */
export const mastery_snapshots = pgTable('mastery_snapshots', {
  id: serial('id').primaryKey(),
  user_id: integer('user_id').notNull(),
  week_start: date('week_start', { mode: 'string' }).notNull(),
  pct: integer('pct').notNull(),
});

export const xp_events = pgTable('xp_events', {
  id: serial('id').primaryKey(),
  user_id: integer('user_id').notNull(),
  amount: integer('amount').notNull(),
  reason: str('reason', 80).notNull(),
  created_at: ts('created_at').notNull().$defaultFn(now),
});

export const daily_activity = pgTable('daily_activity', {
  id: serial('id').primaryKey(),
  user_id: integer('user_id').notNull(),
  day: date('day', { mode: 'string' }).notNull(),
  seconds: integer('seconds').notNull().$defaultFn(() => 0),
});

export const quiz_rounds = pgTable('quiz_rounds', {
  id: serial('id').primaryKey(),
  user_id: integer('user_id').notNull(),
  chapter_id: integer('chapter_id'),
  kind: str('kind', 12).notNull().$defaultFn(() => 'gate'), // gate | daily | review
  version: integer('version').notNull().$defaultFn(() => 1),
  question_refs: json('question_refs').$type<[number, string][]>().notNull(), // [[chapter_id, question_id], ...]
  answers: json('answers').$type<any[]>().notNull().$defaultFn(() => []), // [{choice, correct, left, points}]
  per_question_sec: integer('per_question_sec').notNull().$defaultFn(() => 20),
  score: integer('score').notNull().$defaultFn(() => 0),
  combo: integer('combo').notNull().$defaultFn(() => 1),
  best_combo: integer('best_combo').notNull().$defaultFn(() => 1),
  finished: boolean('finished').notNull().$defaultFn(() => false),
  pct: integer('pct'),
  passed: boolean('passed'),
  created_at: ts('created_at').notNull().$defaultFn(now),
});

export const exam_sessions = pgTable('exam_sessions', {
  id: serial('id').primaryKey(),
  user_id: integer('user_id').notNull(),
  chapter_id: integer('chapter_id').notNull(),
  version: integer('version').notNull().$defaultFn(() => 1),
  started_at: ts('started_at').notNull().$defaultFn(now),
  deadline: ts('deadline').notNull(),
  answers: json('answers').$type<Record<string, any>>().notNull().$defaultFn(() => ({})), // {question_id: answer}
  flags: json('flags').$type<string[]>().notNull().$defaultFn(() => []),
  submitted_at: ts('submitted_at'),
  score: integer('score'),
  passed: boolean('passed'),
  results: json('results').$type<any[] | null>(),
});

/** Code sent for mentor review: a passed Challenge or a project milestone. */
export const submissions = pgTable('submissions', {
  id: serial('id').primaryKey(),
  user_id: integer('user_id').notNull(),
  kind: str('kind', 12).notNull(), // challenge | milestone
  chapter_id: integer('chapter_id'),
  project_id: integer('project_id'),
  milestone: integer('milestone'),
  title: str('title', 160).notNull().$defaultFn(() => ''),
  filename: str('filename', 80).notNull().$defaultFn(() => 'main.js'),
  code: text('code').notNull(),
  attempt_no: integer('attempt_no').notNull().$defaultFn(() => 1),
  tests_passed: integer('tests_passed').notNull().$defaultFn(() => 0),
  tests_total: integer('tests_total').notNull().$defaultFn(() => 0),
  error_line: integer('error_line'),
  status: str('status', 12).notNull().$defaultFn(() => 'pending'), // pending | changes | approved
  summary: text('summary').notNull().$defaultFn(() => ''),
  reviewed_by: integer('reviewed_by'),
  reviewed_at: ts('reviewed_at'),
  seen_by_learner: boolean('seen_by_learner').notNull().$defaultFn(() => true),
  created_at: ts('created_at').notNull().$defaultFn(now),
});

export const review_comments = pgTable('review_comments', {
  id: serial('id').primaryKey(),
  submission_id: integer('submission_id').notNull(),
  author_id: integer('author_id').notNull(),
  line: integer('line').notNull(),
  body: text('body').notNull(),
  created_at: ts('created_at').notNull().$defaultFn(now),
});

export const project_progress = pgTable('project_progress', {
  id: serial('id').primaryKey(),
  user_id: integer('user_id').notNull(),
  project_id: integer('project_id').notNull(),
  milestone: integer('milestone').notNull().$defaultFn(() => 0), // index of the current milestone
  code: text('code').notNull().$defaultFn(() => ''),
  status: str('status', 12).notNull().$defaultFn(() => 'work'), // work | waiting | feedback | portfolio
  last_run: json('last_run').$type<any>(), // {results: [...], logs, error} of the latest run
  published_at: ts('published_at'),
  updated_at: ts('updated_at').notNull().$defaultFn(now),
});

/** Learner ↔ mentor thread (per learner; optionally tied to a project). */
export const messages = pgTable('messages', {
  id: serial('id').primaryKey(),
  learner_id: integer('learner_id').notNull(),
  author_id: integer('author_id').notNull(),
  project_id: integer('project_id'),
  context: str('context', 160).notNull().$defaultFn(() => ''), // "Challenge Papan Skor"
  body: text('body').notNull(),
  read: boolean('read').notNull().$defaultFn(() => false),
  created_at: ts('created_at').notNull().$defaultFn(now),
});

export const notebooks = pgTable('notebooks', {
  id: serial('id').primaryKey(),
  user_id: integer('user_id').notNull(),
  title: str('title', 160).notNull().$defaultFn(() => 'Notebook tanpa judul'),
  attached_chapter_id: integer('attached_chapter_id'),
  cells: json('cells').$type<any[]>().notNull().$defaultFn(() => []), // [{id, type: code|note, src}]
  created_at: ts('created_at').notNull().$defaultFn(now),
  updated_at: ts('updated_at').notNull().$defaultFn(now),
});

/** Mentor-assigned work: a Pahami scene and/or a few Perkuat items. */
export const assignments = pgTable('assignments', {
  id: serial('id').primaryKey(),
  mentor_id: integer('mentor_id').notNull(),
  learner_id: integer('learner_id').notNull(),
  chapter_id: integer('chapter_id'),
  title: str('title', 200).notNull(),
  link: str('link', 200).notNull().$defaultFn(() => ''),
  done: boolean('done').notNull().$defaultFn(() => false),
  created_at: ts('created_at').notNull().$defaultFn(now),
});

export const notifications = pgTable('notifications', {
  id: serial('id').primaryKey(),
  user_id: integer('user_id').notNull(),
  kind: str('kind', 24).notNull(),
  title: str('title', 200).notNull(),
  body: text('body').notNull().$defaultFn(() => ''),
  link: str('link', 200).notNull().$defaultFn(() => ''),
  read: boolean('read').notNull().$defaultFn(() => false),
  created_at: ts('created_at').notNull().$defaultFn(now),
});

/** A learner report such as "output benar tapi gagal" on a challenge test. */
export const content_reports = pgTable('content_reports', {
  id: serial('id').primaryKey(),
  user_id: integer('user_id').notNull(),
  chapter_id: integer('chapter_id').notNull(),
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
