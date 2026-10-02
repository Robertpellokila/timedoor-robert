import {
  boolean, index, integer, jsonb, pgEnum, pgPolicy, pgTable, primaryKey, text,
  timestamp, uniqueIndex, uuid, varchar,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { anonRole, authenticatedRole, realtimeMessages } from 'drizzle-orm/supabase'

const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const workspaceRole = pgEnum('workspace_role', ['owner', 'admin', 'editor', 'host', 'analyst', 'viewer'])
export const quizStatus = pgEnum('quiz_status', ['draft', 'published', 'archived'])
export const sessionState = pgEnum('session_state', [
  'created', 'lobby', 'countdown', 'question_open', 'question_locked', 'reveal',
  'leaderboard', 'paused', 'recovering', 'podium', 'finished', 'cancelled',
])

// IDs match Supabase Auth user UUIDs. Auth itself remains managed by Supabase.
export const profiles = pgTable('profiles', {
  userId: uuid('user_id').primaryKey(),
  displayName: varchar('display_name', { length: 80 }).notNull(),
  locale: varchar('locale', { length: 12 }).default('id-ID').notNull(),
  avatarPath: text('avatar_path'),
  ...timestamps(),
}).enableRLS()

export const workspaces = pgTable('workspaces', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  slug: varchar('slug', { length: 120 }).notNull().unique(),
  ownerId: uuid('owner_id').notNull().references(() => profiles.userId),
  ...timestamps(),
}).enableRLS()

export const workspaceMembers = pgTable('workspace_members', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => profiles.userId, { onDelete: 'cascade' }),
  role: workspaceRole('role').notNull().default('viewer'),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [primaryKey({ columns: [table.workspaceId, table.userId] })]).enableRLS()

export const quizzes = pgTable('quizzes', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  ownerId: uuid('owner_id').notNull().references(() => profiles.userId),
  title: varchar('title', { length: 180 }).notNull(),
  description: text('description'),
  category: varchar('category', { length: 80 }).default('Umum').notNull(),
  visibility: varchar('visibility', { length: 16 }).default('private').notNull(),
  status: quizStatus('status').default('draft').notNull(),
  ...timestamps(),
}, (table) => [index('quizzes_workspace_updated_idx').on(table.workspaceId, table.updatedAt)]).enableRLS()

export const quizDrafts = pgTable('quiz_drafts', {
  quizId: uuid('quiz_id').primaryKey().references(() => quizzes.id, { onDelete: 'cascade' }),
  content: jsonb('content').$type<{ questions: Array<Record<string, unknown>> }>().notNull(),
  revision: integer('revision').notNull().default(1),
  ...timestamps(),
}).enableRLS()

// Sessions point at an immutable version, so later edits cannot change old results.
export const quizVersions = pgTable('quiz_versions', {
  id: uuid('id').defaultRandom().primaryKey(),
  quizId: uuid('quiz_id').notNull().references(() => quizzes.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  contentHash: varchar('content_hash', { length: 64 }).notNull(),
  titleSnapshot: varchar('title_snapshot', { length: 180 }).notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex('quiz_versions_quiz_version_uidx').on(table.quizId, table.version)]).enableRLS()

export const questions = pgTable('questions', {
  id: uuid('id').defaultRandom().primaryKey(),
  quizVersionId: uuid('quiz_version_id').notNull().references(() => quizVersions.id, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(),
  type: varchar('type', { length: 32 }).notNull(),
  prompt: text('prompt').notNull(),
  answerSchemaVersion: integer('answer_schema_version').default(1).notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().default({}).notNull(),
  answerKey: jsonb('answer_key').$type<unknown>().notNull(),
  durationMs: integer('duration_ms').default(20000).notNull(),
  basePoints: integer('base_points').default(1000).notNull(),
  ...timestamps(),
}, (table) => [uniqueIndex('questions_version_sequence_uidx').on(table.quizVersionId, table.sequence)]).enableRLS()

export const sessions = pgTable('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  quizVersionId: uuid('quiz_version_id').notNull().references(() => quizVersions.id),
  hostId: uuid('host_id').notNull().references(() => profiles.userId),
  mode: varchar('mode', { length: 24 }).notNull().default('live_individual'),
  state: sessionState('state').notNull().default('created'),
  pausedFrom: sessionState('paused_from'),
  stateVersion: integer('state_version').notNull().default(0),
  eventSeq: integer('event_seq').notNull().default(0),
  currentQuestionIndex: integer('current_question_index').notNull().default(-1),
  openedAt: timestamp('opened_at', { withTimezone: true }),
  deadlineAt: timestamp('deadline_at', { withTimezone: true }),
  pinHash: varchar('pin_hash', { length: 128 }).notNull(),
  pinExpiresAt: timestamp('pin_expires_at', { withTimezone: true }).notNull(),
  rulesetVersion: varchar('ruleset_version', { length: 32 }).notNull().default('default-v1'),
  ...timestamps(),
}, (table) => [
  index('sessions_state_created_idx').on(table.state, table.createdAt),
  uniqueIndex('sessions_pin_hash_uidx').on(table.pinHash),
]).enableRLS()

export const participants = pgTable('participants', {
  id: uuid('id').defaultRandom().primaryKey(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  tokenHash: varchar('token_hash', { length: 128 }).notNull(),
  nickname: varchar('nickname', { length: 32 }).notNull(),
  avatar: varchar('avatar', { length: 16 }).notNull().default('🦊'),
  nicknameNormalized: varchar('nickname_normalized', { length: 32 }).notNull(),
  connected: boolean('connected').default(true).notNull(),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('participants_nickname_session_uidx').on(table.sessionId, table.nicknameNormalized),
  index('participants_session_joined_idx').on(table.sessionId, table.joinedAt),
]).enableRLS()

export const submissions = pgTable('submissions', {
  id: uuid('id').defaultRandom().primaryKey(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  participantId: uuid('participant_id').notNull().references(() => participants.id, { onDelete: 'cascade' }),
  questionId: uuid('question_id').notNull().references(() => questions.id),
  requestId: uuid('request_id').notNull(),
  payload: jsonb('payload').$type<unknown>().notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  isCorrect: boolean('is_correct').notNull(),
  points: integer('points').default(0).notNull(),
  latencyMs: integer('latency_ms'),
}, (table) => [
  uniqueIndex('submissions_once_per_question_uidx').on(table.sessionId, table.participantId, table.questionId),
  uniqueIndex('submissions_request_id_uidx').on(table.requestId),
  index('submissions_session_received_idx').on(table.sessionId, table.receivedAt),
]).enableRLS()

export const sessionEvents = pgTable('session_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  eventSeq: integer('event_seq').notNull(),
  eventType: varchar('event_type', { length: 32 }).notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().default({}).notNull(),
  committedAt: timestamp('committed_at', { withTimezone: true }).defaultNow().notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('session_events_seq_uidx').on(table.sessionId, table.eventSeq),
  index('session_events_pending_idx').on(table.publishedAt, table.committedAt),
]).enableRLS()

// Session IDs and their derived channel keys are bearer capabilities. Only receive
// access is granted here; clients cannot publish or send presence to session channels.
export const sessionBroadcastReadPolicy = pgPolicy('session_participants_receive_broadcasts', {
  for: 'select',
  to: [anonRole, authenticatedRole],
  using: sql`${realtimeMessages.extension} = 'broadcast' and realtime.topic() ~ '^session:[0-9a-f-]{36}:[0-9a-f]{64}$'`,
}).link(realtimeMessages)
