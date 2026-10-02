import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { createMiddleware } from 'hono/factory'
import { createClient } from '@supabase/supabase-js'
import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm'
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { db, dbClient as databaseClient } from './db/index.js'
import { participants, profiles, questions, quizDrafts, quizVersions, quizzes, sessionEvents, sessions, submissions, workspaceMembers, workspaces } from './db/schema.js'
import { z } from 'zod'

const required = (key: string) => {
  const value = process.env[key]
  if (!value) throw new Error(`${key} belum dikonfigurasi`)
  return value
}
const supabaseUrl = required('VITE_SUPABASE_URL')
const anonKey = required('VITE_SUPABASE_ANON_KEY')
const authClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
const pinPepper = createHash('sha256').update(`ruang-kuis-pin:${required('DATABASE_URL')}`).digest('hex')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const app = new Hono()
app.use('/api/*', cors({ origin: (origin) => {
  const configured = process.env.WEB_ORIGIN ?? 'http://localhost:5173'
  if (origin === configured || /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return origin
  return configured
}, allowHeaders: ['Content-Type', 'Authorization'], allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'] }))
app.get('/health', (c) => c.json({ ok: true, service: 'ruang-kuis-api' }))
const joinWindows = new Map<string, { start: number; count: number }>()
app.use('/api/v1/join', async (c, next) => {
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-real-ip') ?? 'local'
  const now = Date.now(), current = joinWindows.get(ip)
  const bucket = !current || now - current.start > 60_000 ? { start: now, count: 0 } : current
  bucket.count++
  joinWindows.set(ip, bucket)
  if (bucket.count > 30) return c.json({ error: 'JOIN_RATE_LIMITED' }, 429)
  await next()
})

type AuthVars = { userId: string }
const requireUser = createMiddleware<{ Variables: AuthVars }>(async (c, next) => {
  const authorization = c.req.header('Authorization')
  if (!authorization?.startsWith('Bearer ')) return c.json({ error: 'AUTH_REQUIRED' }, 401)
  const { data, error } = await authClient.auth.getUser(authorization.slice(7))
  if (error || !data.user) return c.json({ error: 'INVALID_TOKEN' }, 401)
  c.set('userId', data.user.id)
  await next()
})

const questionInput = z.object({
  type: z.enum(['quiz', 'true_false', 'slide', 'multi_select', 'type_answer', 'puzzle', 'poll', 'word_cloud', 'open_ended', 'hotspot', 'scale', 'slider', 'nps_scale', 'pin_answer', 'drop_pin', 'brainstorm']).default('quiz'),
  prompt: z.string().trim().min(1).max(2000),
  options: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
  correctIndex: z.number().int().min(0).optional(),
  correctIndices: z.array(z.number().int().min(0).max(7)).min(1).max(8).optional(),
  minValue: z.number().finite().min(-10000).max(10000).optional(),
  maxValue: z.number().finite().min(-10000).max(10000).optional(),
  correctValue: z.number().finite().min(-10000).max(10000).optional(),
  target: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
  seconds: z.number().int().min(5).max(240).default(20),
  points: z.number().int().min(0).max(10000).default(1000),
  explanation: z.string().max(1000).optional(),
}).superRefine((q, ctx) => {
  if (q.type === 'quiz' && (q.options.length < 2 || q.correctIndex === undefined || q.correctIndex >= q.options.length)) {
    ctx.addIssue({ code: 'custom', message: 'Soal pilihan ganda perlu 2–8 opsi dan satu kunci jawaban.' })
  }
  if (q.type === 'true_false' && (q.options.length !== 2 || q.correctIndex === undefined || q.correctIndex > 1)) {
    ctx.addIssue({ code: 'custom', message: 'Soal benar/salah perlu dua opsi dan satu kunci jawaban.' })
  }
  if (q.type === 'multi_select' && (!q.correctIndices?.length || q.correctIndices.some((i) => i >= q.options.length))) {
    ctx.addIssue({ code: 'custom', message: 'Pilih setidaknya satu jawaban benar.' })
  }
  if (q.type === 'puzzle' && (!q.correctIndices || q.correctIndices.length !== q.options.length || new Set(q.correctIndices).size !== q.options.length || q.correctIndices.some((i) => i >= q.options.length))) {
    ctx.addIssue({ code: 'custom', message: 'Urutan puzzle harus mencakup setiap pilihan tepat satu kali.' })
  }
  if (q.type === 'type_answer' && !q.options[0]?.trim()) ctx.addIssue({ code: 'custom', message: 'Isi setidaknya satu kunci jawaban.' })
  if (q.type === 'pin_answer' && !q.target) ctx.addIssue({ code: 'custom', message: 'Tentukan titik jawaban pada peta.' })
  if (['slider', 'scale', 'nps_scale'].includes(q.type) && (q.minValue === undefined || q.maxValue === undefined || q.minValue >= q.maxValue)) ctx.addIssue({ code: 'custom', message: 'Rentang skala tidak valid.' })
  if (q.type === 'slider' && (q.correctValue === undefined || q.correctValue < (q.minValue ?? 0) || q.correctValue > (q.maxValue ?? 0))) ctx.addIssue({ code: 'custom', message: 'Tentukan nilai benar di dalam rentang slider.' })
})
const draftInput = z.object({
  title: z.string().trim().min(1).max(180),
  description: z.string().max(2000).optional(),
  category: z.string().trim().max(80).default('Umum'),
  questions: z.array(questionInput).min(1).max(100),
})

async function ensureUser(userId: string) {
  await db.insert(profiles).values({ userId, displayName: 'Pengajar' }).onConflictDoNothing()
}
async function ownedQuiz(quizId: string, userId: string) {
  const [quiz] = await db.select().from(quizzes).where(and(eq(quizzes.id, quizId), eq(quizzes.ownerId, userId))).limit(1)
  return quiz
}
async function addEvent(tx: any, sessionId: string, eventSeq: number, eventType: string, payload: Record<string, unknown>) {
  await tx.insert(sessionEvents).values({ sessionId, eventSeq, eventType, payload })
}
function pinDigest(pin: string) { return hash(`${pinPepper}:${pin}`) }
function realtimeTopic(sessionId: string, pinHash: string) { return `session:${sessionId}:${hash(`${pinHash}:realtime`)}` }
function databaseErrorCode(error: unknown) {
  const value = error as { code?: string; cause?: { code?: string } }
  return value?.code ?? value?.cause?.code
}
function bearer(c: Context) {
  const h = c.req.header('Authorization')
  return h?.startsWith('Bearer ') ? h.slice(7) : ''
}
async function resolveSessionAccess(token: string, sessionId: string) {
  if (!token) return null
  if (token.startsWith('guest_')) {
    const [participant] = await db.select().from(participants).where(and(eq(participants.sessionId, sessionId), eq(participants.tokenHash, hash(token)))).limit(1)
    return participant ? { role: 'participant' as const, participantId: participant.id } : null
  }
  const { data } = await authClient.auth.getUser(token)
  if (!data.user) return null
  const [session] = await db.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.id, sessionId), eq(sessions.hostId, data.user.id))).limit(1)
  return session ? { role: 'host' as const, participantId: null } : null
}

app.get('/api/v1/me', requireUser, async (c) => {
  const userId = c.get('userId')
  await ensureUser(userId)
  const [profile] = await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1)
  const memberships = await db.select({ workspace: workspaces, role: workspaceMembers.role }).from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId)).where(eq(workspaceMembers.userId, userId))
  return c.json({ profile, workspaces: memberships })
})

app.get('/api/v1/quizzes', requireUser, async (c) => {
  const items = await db.select({ quiz: quizzes, draft: quizDrafts.content }).from(quizzes)
    .leftJoin(quizDrafts, eq(quizDrafts.quizId, quizzes.id)).where(eq(quizzes.ownerId, c.get('userId'))).orderBy(desc(quizzes.updatedAt))
  const enriched = await Promise.all(items.map(async ({ quiz, draft }) => {
    const [version] = await db.select().from(quizVersions).where(eq(quizVersions.quizId, quiz.id)).orderBy(desc(quizVersions.version)).limit(1)
    const [count] = version ? await db.select({ count: sql<number>`count(*)::int` }).from(questions).where(eq(questions.quizVersionId, version.id)) : [{ count: 0 }]
    return { ...quiz, draft, latestVersionId: version?.id ?? null, questionCount: count.count }
  }))
  return c.json({ quizzes: enriched })
})

app.post('/api/v1/quizzes', requireUser, async (c) => {
  const userId = c.get('userId')
  const parsed = draftInput.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'INVALID_QUIZ', details: parsed.error.flatten() }, 400)
  await ensureUser(userId)
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.ownerId, userId)).limit(1)
  const owningWorkspace = workspace ?? (await db.insert(workspaces).values({ ownerId: userId, name: 'Workspace saya', slug: `kelas-${userId.slice(0, 8)}-${randomBytes(3).toString('hex')}` }).returning())[0]
  const [quiz] = await db.insert(quizzes).values({ workspaceId: owningWorkspace.id, ownerId: userId, title: parsed.data.title, description: parsed.data.description, category: parsed.data.category }).returning()
  await db.insert(workspaceMembers).values({ workspaceId: owningWorkspace.id, userId, role: 'owner' }).onConflictDoNothing()
  await db.insert(quizDrafts).values({ quizId: quiz.id, content: { questions: parsed.data.questions as Array<Record<string, unknown>> } })
  return c.json({ quiz }, 201)
})

app.patch('/api/v1/quizzes/:id', requireUser, async (c) => {
  const userId = c.get('userId')
  const quizId = z.string().uuid().safeParse(c.req.param('id'))
  const parsed = draftInput.safeParse(await c.req.json().catch(() => null))
  if (!quizId.success || !parsed.success) return c.json({ error: 'INVALID_QUIZ', details: parsed.success ? undefined : parsed.error.flatten() }, 400)
  const existing = await ownedQuiz(quizId.data, userId)
  if (!existing) return c.json({ error: 'QUIZ_NOT_FOUND' }, 404)
  const result = await db.transaction(async (tx) => {
    const [quiz] = await tx.update(quizzes).set({ title: parsed.data.title, description: parsed.data.description, category: parsed.data.category, updatedAt: new Date() }).where(eq(quizzes.id, quizId.data)).returning()
    await tx.insert(quizDrafts).values({ quizId: quiz.id, content: { questions: parsed.data.questions as Array<Record<string, unknown>> }, revision: 1 })
      .onConflictDoUpdate({ target: quizDrafts.quizId, set: { content: { questions: parsed.data.questions as Array<Record<string, unknown>> }, revision: sql`${quizDrafts.revision} + 1`, updatedAt: new Date() } })
    return quiz
  })
  return c.json({ quiz: result })
})

app.post('/api/v1/quizzes/:id/publish', requireUser, async (c) => {
  const quizId = z.string().uuid().safeParse(c.req.param('id'))
  if (!quizId.success) return c.json({ error: 'INVALID_QUIZ_ID' }, 400)
  const quiz = await ownedQuiz(quizId.data, c.get('userId'))
  if (!quiz) return c.json({ error: 'QUIZ_NOT_FOUND' }, 404)
  const [draft] = await db.select().from(quizDrafts).where(eq(quizDrafts.quizId, quiz.id)).limit(1)
  if (!draft) return c.json({ error: 'DRAFT_NOT_FOUND' }, 404)
  const checked = draftInput.safeParse({ title: quiz.title, description: quiz.description ?? undefined, category: quiz.category, ...draft.content })
  if (!checked.success) return c.json({ error: 'INVALID_QUIZ', details: checked.error.flatten() }, 400)
  const result = await db.transaction(async (tx) => {
    const [latest] = await tx.select({ version: quizVersions.version }).from(quizVersions).where(eq(quizVersions.quizId, quiz.id)).orderBy(desc(quizVersions.version)).limit(1)
    const versionNumber = (latest?.version ?? 0) + 1
    const snapshot = { title: quiz.title, description: quiz.description, category: quiz.category, questions: checked.data.questions }
    const contentHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
    const [version] = await tx.insert(quizVersions).values({ quizId: quiz.id, version: versionNumber, contentHash, titleSnapshot: quiz.title }).returning()
    await tx.insert(questions).values(checked.data.questions.map((q, i) => ({
      quizVersionId: version.id, sequence: i, type: q.type, prompt: q.prompt,
      config: { options: q.options, explanation: q.explanation, minValue: q.minValue, maxValue: q.maxValue }, answerKey: q.type === 'pin_answer' ? { target: q.target } : q.type === 'drop_pin' ? null : q.type === 'slider' ? { correctValue: q.correctValue } : q.type === 'multi_select' ? { correctIndices: q.correctIndices } : q.type === 'puzzle' ? { correctOrder: q.correctIndices ?? q.options.map((_, i) => i) } : q.correctIndex === undefined ? null : { correctIndex: q.correctIndex },
      durationMs: q.seconds * 1000, basePoints: q.points,
    })))
    await tx.update(quizzes).set({ status: 'published', updatedAt: new Date() }).where(eq(quizzes.id, quiz.id))
    return version
  })
  return c.json({ version: result }, 201)
})

app.post('/api/v1/sessions', requireUser, async (c) => {
  const input = z.object({ quizId: z.string().uuid() }).safeParse(await c.req.json().catch(() => null))
  if (!input.success) return c.json({ error: 'INVALID_REQUEST' }, 400)
  const [version] = await db.select({ version: quizVersions, quiz: quizzes }).from(quizVersions).innerJoin(quizzes, eq(quizzes.id, quizVersions.quizId))
    .where(and(eq(quizVersions.quizId, input.data.quizId), eq(quizzes.ownerId, c.get('userId')))).orderBy(desc(quizVersions.version)).limit(1)
  if (!version) return c.json({ error: 'QUIZ_VERSION_NOT_FOUND' }, 404)
  let pin = ''
  let session: typeof sessions.$inferSelect | undefined
  for (let attempt = 0; attempt < 5 && !session; attempt++) {
    pin = String(randomInt(10_000_000, 100_000_000))
    try {
      [session] = await db.insert(sessions).values({ quizVersionId: version.version.id, hostId: c.get('userId'), state: 'lobby', eventSeq: 1, pinHash: pinDigest(pin), pinExpiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000) }).returning()
    } catch (error: any) { if (databaseErrorCode(error) !== '23505') throw error }
  }
  if (!session) return c.json({ error: 'PIN_GENERATION_FAILED' }, 503)
  await db.insert(sessionEvents).values({ sessionId: session.id, eventSeq: 1, eventType: 'LOBBY', payload: { state: 'lobby' } })
  return c.json({ session: { id: session.id, state: session.state, stateVersion: session.stateVersion, pin, pinExpiresAt: session.pinExpiresAt, realtimeTopic: realtimeTopic(session.id, session.pinHash) }, hostUrl: `/host/${session.id}` }, 201)
})

app.post('/api/v1/join', async (c) => {
  const input = z.object({ pin: z.string().regex(/^\d{6,8}$/), nickname: z.string().trim().min(1).max(24), avatar: z.string().emoji().max(16).default('🦊') }).safeParse(await c.req.json().catch(() => null))
  if (!input.success) return c.json({ error: 'INVALID_JOIN', details: input.error.flatten() }, 400)
  const [session] = await db.select().from(sessions).where(and(eq(sessions.pinHash, pinDigest(input.data.pin)), gt(sessions.pinExpiresAt, new Date()), eq(sessions.state, 'lobby'))).limit(1)
  if (!session) return c.json({ error: 'SESSION_NOT_FOUND_OR_LOCKED' }, 404)
  const [{ count: playerCount }] = await db.select({ count: sql<number>`count(*)::int` }).from(participants).where(eq(participants.sessionId, session.id))
  if (playerCount >= 100) return c.json({ error: 'SESSION_FULL' }, 409)
  const token = `guest_${randomBytes(32).toString('base64url')}`
  const baseName = input.data.nickname.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24)
  if (!baseName) return c.json({ error: 'INVALID_NICKNAME' }, 400)
  const normalized = (s: string) => s.normalize('NFKC').toLocaleLowerCase('id-ID')
  let participant: typeof participants.$inferSelect | undefined
  let nickname = baseName
  for (let suffix = 0; suffix < 20 && !participant; suffix++) {
    nickname = suffix ? `${baseName.slice(0, 19)} ${suffix + 1}` : baseName
    try { [participant] = await db.insert(participants).values({ sessionId: session.id, tokenHash: hash(token), nickname, avatar: input.data.avatar, nicknameNormalized: normalized(nickname) }).returning() }
    catch (error: any) { if (databaseErrorCode(error) !== '23505') throw error }
  }
  if (!participant) return c.json({ error: 'NICKNAME_CONFLICT' }, 409)
  await db.transaction(async (tx) => {
    // Older sessions may have event_seq=0 even though their initial LOBBY event
    // is already sequence 1. Continue after the newest persisted event to avoid
    // a unique-key collision when the first guest joins.
    const [updated] = await tx.update(sessions).set({
      eventSeq: sql`greatest(${sessions.eventSeq}, coalesce((select max(event_seq) from session_events where session_id = ${session.id}), 0)) + 1`,
      updatedAt: new Date(),
    }).where(eq(sessions.id, session.id)).returning({ eventSeq: sessions.eventSeq })
    await addEvent(tx, session.id, updated.eventSeq, 'PLAYER_JOINED', {})
  })
  const [version] = await db.select({ title: quizVersions.titleSnapshot }).from(quizVersions).where(eq(quizVersions.id, session.quizVersionId)).limit(1)
  return c.json({ participant: { id: participant.id, nickname, avatar: participant.avatar }, participantToken: token, sessionId: session.id, realtimeTopic: realtimeTopic(session.id, session.pinHash), quizTitle: version?.title ?? 'Kuis' }, 201)
})

app.get('/api/v1/sessions/:id/snapshot', async (c) => {
  const sessionId = z.string().uuid().safeParse(c.req.param('id'))
  if (!sessionId.success) return c.json({ error: 'INVALID_SESSION_ID' }, 400)
  const access = await resolveSessionAccess(bearer(c), sessionId.data)
  if (!access) return c.json({ error: 'FORBIDDEN' }, 403)
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId.data)).limit(1)
  if (!session) return c.json({ error: 'SESSION_NOT_FOUND' }, 404)
  const [version] = await db.select().from(quizVersions).where(eq(quizVersions.id, session.quizVersionId)).limit(1)
  const list = await db.select().from(questions).where(eq(questions.quizVersionId, session.quizVersionId)).orderBy(asc(questions.sequence))
  const q = list[session.currentQuestionIndex]
  let playerScore: { score: number; correct: number } | null = null
  if (access.role === 'participant' && access.participantId) {
    const [score] = await db.select({ score: sql<number>`coalesce(sum(${submissions.points}),0)::int`, correct: sql<number>`count(*) filter (where ${submissions.isCorrect})::int` }).from(submissions).where(eq(submissions.participantId, access.participantId))
    playerScore = score
  }
  let leaderboard: Array<{ nickname: string; avatar: string; score: number; correct: number }> | undefined
  let playerList: Array<{ nickname: string }> | undefined
  if (access.role === 'host') playerList = await db.select({ nickname: participants.nickname, avatar: participants.avatar }).from(participants).where(eq(participants.sessionId, session.id)).orderBy(asc(participants.joinedAt))
  if (access.role === 'host' || session.state === 'leaderboard' || session.state === 'podium' || session.state === 'finished') {
    leaderboard = await db.select({ nickname: participants.nickname, avatar: participants.avatar, score: sql<number>`coalesce(sum(${submissions.points}),0)::int`, correct: sql<number>`count(*) filter (where ${submissions.isCorrect})::int` })
      .from(participants).leftJoin(submissions, eq(submissions.participantId, participants.id)).where(eq(participants.sessionId, session.id))
      .groupBy(participants.id, participants.avatar).orderBy(desc(sql`coalesce(sum(${submissions.points}),0)`), desc(sql`count(*) filter (where ${submissions.isCorrect})`))
  }
  const question = q ? {
    id: q.id, sequence: q.sequence, type: q.type, prompt: q.prompt,
    options: (q.config as any).options ?? [], durationMs: q.durationMs,
    minValue: (q.config as any).minValue, maxValue: (q.config as any).maxValue,
    ...(access.role === 'host' || session.state === 'reveal' || session.state === 'leaderboard' || session.state === 'podium' ? { answerKey: q.answerKey, explanation: (q.config as any).explanation } : {}),
  } : null
  return c.json({ session: { id: session.id, state: session.state, stateVersion: session.stateVersion, eventSeq: session.eventSeq, pinExpiresAt: session.pinExpiresAt, openedAt: session.openedAt, deadlineAt: session.deadlineAt, questionIndex: session.currentQuestionIndex }, quiz: { title: version?.titleSnapshot, questionCount: list.length }, question, playerScore, leaderboard, participants: playerList, participantCount: playerList?.length, role: access.role, serverTime: new Date().toISOString() })
})

const commandInput = z.object({ command: z.enum(['START', 'PAUSE', 'RESUME', 'REVEAL', 'NEXT', 'FINISH']), expectedVersion: z.number().int().nonnegative() })
app.post('/api/v1/sessions/:id/commands', requireUser, async (c) => {
  const sessionId = z.string().uuid().safeParse(c.req.param('id'))
  const input = commandInput.safeParse(await c.req.json().catch(() => null))
  if (!sessionId.success || !input.success) return c.json({ error: 'INVALID_COMMAND' }, 400)
  const result = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(sessions).where(and(eq(sessions.id, sessionId.data), eq(sessions.hostId, c.get('userId')))).for('update').limit(1)
    if (!current) return { error: 'SESSION_NOT_FOUND', status: 404 as const }
    if (current.stateVersion !== input.data.expectedVersion) return { error: 'STATE_CONFLICT', stateVersion: current.stateVersion, status: 409 as const }
    const list = await tx.select().from(questions).where(eq(questions.quizVersionId, current.quizVersionId)).orderBy(asc(questions.sequence))
    const now = new Date()
    let state: typeof current.state = current.state
    let pausedFrom: typeof current.pausedFrom = current.pausedFrom
    let index = current.currentQuestionIndex
    let openedAt = current.openedAt
    let deadlineAt = current.deadlineAt
    if (input.data.command === 'START' && current.state === 'lobby') {
      if (!list[0]) return { error: 'QUIZ_HAS_NO_QUESTIONS', status: 409 as const }
      state = 'question_open'; index = 0; openedAt = now; deadlineAt = new Date(now.getTime() + list[0].durationMs)
    } else if (input.data.command === 'PAUSE' && ['lobby', 'question_open', 'reveal', 'leaderboard'].includes(current.state)) {
      pausedFrom = current.state; state = 'paused'
    } else if (input.data.command === 'RESUME' && current.state === 'paused' && current.pausedFrom) {
      state = current.pausedFrom; pausedFrom = null
      if (state === 'question_open' && deadlineAt && deadlineAt <= now) state = 'question_locked'
    } else if (input.data.command === 'REVEAL' && (current.state === 'question_open' || current.state === 'question_locked')) {
      state = 'reveal'
    } else if (input.data.command === 'NEXT' && ['reveal', 'leaderboard'].includes(current.state)) {
      if (index + 1 >= list.length) state = 'podium'
      else { index += 1; state = 'question_open'; openedAt = now; deadlineAt = new Date(now.getTime() + list[index].durationMs) }
    } else if (input.data.command === 'FINISH' && ['podium', 'lobby'].includes(current.state)) {
      state = 'finished'
    } else return { error: 'INVALID_STATE_TRANSITION', state: current.state, status: 409 as const }
    const [updated] = await tx.update(sessions).set({ state, pausedFrom, currentQuestionIndex: index, openedAt, deadlineAt, stateVersion: current.stateVersion + 1, eventSeq: sql`greatest(${sessions.eventSeq}, coalesce((select max(event_seq) from session_events where session_id = ${current.id}), 0)) + 1`, updatedAt: now }).where(and(eq(sessions.id, current.id), eq(sessions.stateVersion, current.stateVersion))).returning()
    await addEvent(tx, updated.id, updated.eventSeq, input.data.command, { state: updated.state, stateVersion: updated.stateVersion, currentQuestionIndex: updated.currentQuestionIndex, openedAt, deadlineAt })
    return { session: { id: updated.id, state: updated.state, stateVersion: updated.stateVersion, eventSeq: updated.eventSeq, questionIndex: updated.currentQuestionIndex, openedAt, deadlineAt } }
  })
  if ('error' in result) return c.json(result, result.status)
  void dispatchOutbox()
  return c.json(result)
})

app.post('/api/v1/sessions/:id/answers', async (c) => {
  const sessionId = z.string().uuid().safeParse(c.req.param('id'))
  const input = z.object({ questionId: z.string().uuid(), requestId: z.string().uuid(), answer: z.union([z.number().finite().min(-10000).max(10000), z.array(z.number().int().min(0).max(7)).min(1).max(8), z.string().trim().min(1).max(500), z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })]) }).safeParse(await c.req.json().catch(() => null))
  if (!sessionId.success || !input.success) return c.json({ error: 'INVALID_ANSWER' }, 400)
  const token = bearer(c)
  if (!token.startsWith('guest_')) return c.json({ error: 'PARTICIPANT_TOKEN_REQUIRED' }, 401)
  const [participant] = await db.select().from(participants).where(and(eq(participants.sessionId, sessionId.data), eq(participants.tokenHash, hash(token)))).limit(1)
  if (!participant) return c.json({ error: 'INVALID_PARTICIPANT' }, 401)
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId.data)).limit(1)
  if (!session || session.state !== 'question_open') return c.json({ error: 'SESSION_LOCKED' }, 409)
  const [question] = await db.select().from(questions).where(and(eq(questions.quizVersionId, session.quizVersionId), eq(questions.sequence, session.currentQuestionIndex))).limit(1)
  if (!question || question.id !== input.data.questionId) return c.json({ error: 'QUESTION_MISMATCH' }, 409)
  const receivedAt = new Date()
  if (!session.deadlineAt || receivedAt > session.deadlineAt) return c.json({ error: 'ANSWER_TOO_LATE' }, 409)
  const key = question.answerKey as any
  const config = question.config as any
  const options = config.options ?? []
  const answer = input.data.answer
  const isTextAnswer = ['type_answer', 'open_ended', 'word_cloud', 'brainstorm'].includes(question.type)
  const isArrayAnswer = question.type === 'puzzle'
  const isPinAnswer = ['pin_answer', 'drop_pin'].includes(question.type)
  const isRangeAnswer = ['slider', 'scale', 'nps_scale'].includes(question.type)
  const point = typeof answer === 'object' && !Array.isArray(answer) && answer !== null && 'x' in answer && 'y' in answer ? answer as {x:number;y:number} : null
  if (!Array.isArray(options) || question.type === 'slide' ||
    (isTextAnswer && typeof answer !== 'string') ||
    (isArrayAnswer && (!Array.isArray(answer) || answer.some((i) => i >= options.length))) ||
    (isPinAnswer && !point) ||
    (isRangeAnswer && (typeof answer !== 'number' || answer < config.minValue || answer > config.maxValue)) ||
    (!isTextAnswer && !isArrayAnswer && !isPinAnswer && !isRangeAnswer && (typeof answer !== 'number' || !Number.isInteger(answer) || answer < 0 || answer >= options.length))) return c.json({ error: 'INVALID_ANSWER' }, 400)
  const submittedIndices = Array.isArray(answer) ? answer : []
  const isCorrect = question.type === 'type_answer'
    ? String(answer).normalize('NFKC').trim().toLocaleLowerCase('id-ID') === String(options[0] ?? '').normalize('NFKC').trim().toLocaleLowerCase('id-ID')
    : question.type === 'puzzle'
      ? submittedIndices.join(',') === (key?.correctOrder ?? []).join(',')
      : question.type === 'slider'
        ? Math.abs(Number(answer) - Number(key?.correctValue)) <= Math.max(1, (config.maxValue - config.minValue) * 0.05)
        : question.type === 'pin_answer'
          ? Math.hypot(point!.x - key.target.x, point!.y - key.target.y) <= 0.08
          : ['quiz', 'true_false'].includes(question.type) && answer === key?.correctIndex
  const durationMs = Math.max(1, question.durationMs)
  const remainingMs = Math.max(0, Math.min(durationMs, session.deadlineAt.getTime() - receivedAt.getTime()))
  const points = isCorrect ? Math.round(question.basePoints * (0.5 + 0.5 * remainingMs / durationMs)) : 0
  try {
    const [receipt] = await db.insert(submissions).values({ sessionId: session.id, participantId: participant.id, questionId: question.id, requestId: input.data.requestId, payload: { answer: input.data.answer }, receivedAt, isCorrect, points, latencyMs: Math.max(0, durationMs - remainingMs) }).returning()
    return c.json({ receipt: { id: receipt.id, receivedAt: receipt.receivedAt, isCorrect: receipt.isCorrect, points: receipt.points } }, 201)
  } catch (error: any) {
    if (databaseErrorCode(error) === '23505') {
      const [prior] = await db.select().from(submissions).where(and(eq(submissions.sessionId, session.id), eq(submissions.participantId, participant.id), eq(submissions.questionId, question.id))).limit(1)
      if (prior) return c.json({ receipt: { id: prior.id, receivedAt: prior.receivedAt, isCorrect: prior.isCorrect, points: prior.points }, duplicate: true })
      return c.json({ error: 'DUPLICATE_SUBMISSION' }, 409)
    }
    throw error
  }
})

app.get('/api/v1/sessions/:id/events', async (c) => {
  const sessionId = z.string().uuid().safeParse(c.req.param('id'))
  const after = z.coerce.number().int().nonnegative().catch(0).parse(c.req.query('after'))
  if (!sessionId.success) return c.json({ error: 'INVALID_SESSION_ID' }, 400)
  const access = await resolveSessionAccess(bearer(c), sessionId.data)
  if (!access) return c.json({ error: 'FORBIDDEN' }, 403)
  const events = await db.select({ eventSeq: sessionEvents.eventSeq, eventType: sessionEvents.eventType, payload: sessionEvents.payload, committedAt: sessionEvents.committedAt }).from(sessionEvents)
    .where(and(eq(sessionEvents.sessionId, sessionId.data), gt(sessionEvents.eventSeq, after))).orderBy(asc(sessionEvents.eventSeq)).limit(100)
  return c.json({ events })
})

app.get('/api/v1/sessions/:id/results', requireUser, async (c) => {
  const sessionId = z.string().uuid().safeParse(c.req.param('id'))
  if (!sessionId.success) return c.json({ error: 'INVALID_SESSION_ID' }, 400)
  const [session] = await db.select().from(sessions).where(and(eq(sessions.id, sessionId.data), eq(sessions.hostId, c.get('userId')))).limit(1)
  if (!session) return c.json({ error: 'SESSION_NOT_FOUND' }, 404)
  const rows = await db.select({ nickname: participants.nickname, score: sql<number>`coalesce(sum(${submissions.points}),0)::int`, correct: sql<number>`count(*) filter (where ${submissions.isCorrect})::int`, latency: sql<number>`coalesce(sum(${submissions.latencyMs}),0)::int` })
    .from(participants).leftJoin(submissions, eq(submissions.participantId, participants.id)).where(eq(participants.sessionId, session.id)).groupBy(participants.id)
    .orderBy(desc(sql`coalesce(sum(${submissions.points}),0)`), desc(sql`count(*) filter (where ${submissions.isCorrect})`), asc(sql`coalesce(sum(${submissions.latencyMs}),0)`))
  return c.json({ sessionId: session.id, state: session.state, results: rows })
})

app.onError((error, c) => {
  const cause = error as Error & { code?: string; constraint?: string; cause?: Error & { code?: string; constraint?: string } }
  console.error('api_error', { path: c.req.path, message: cause.message, code: cause.code ?? cause.cause?.code, constraint: cause.constraint ?? cause.cause?.constraint, cause: cause.cause?.message })
  return c.json({ error: 'INTERNAL_ERROR' }, 500)
})

const port = Number(process.env.API_PORT ?? 8787)
let dispatching = false
async function dispatchOutbox() {
  if (dispatching) return
  dispatching = true
  try {
    const pending = await db.select({ event: sessionEvents, session: sessions }).from(sessionEvents).innerJoin(sessions, eq(sessions.id, sessionEvents.sessionId))
      .where(isNull(sessionEvents.publishedAt)).orderBy(asc(sessionEvents.committedAt)).limit(50)
    for (const row of pending) {
      const channel = realtimeTopic(row.session.id, row.session.pinHash)
      const payload = { eventSeq: row.event.eventSeq, eventType: row.event.eventType, ...(row.event.payload as Record<string, unknown>) }
      await db.execute(sql`select realtime.send(${JSON.stringify(payload)}::jsonb, 'session_event', ${channel}, true)`)
      await db.update(sessionEvents).set({ publishedAt: new Date() }).where(eq(sessionEvents.id, row.event.id))
    }
  } catch (error: any) {
    console.error('realtime_outbox_error', { message: error.message })
  } finally { dispatching = false }
}
const outboxTimer = setInterval(() => void dispatchOutbox(), 700)
outboxTimer.unref()
serve({ fetch: app.fetch, port }, (info) => console.log(`Ruang Kuis API listening on ${info.port}`))
process.on('SIGTERM', async () => { clearInterval(outboxTimer); await databaseClient.end(); process.exit(0) })
