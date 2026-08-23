/**
 * The in-memory dropin. Plain data plus the rules the API actually enforces — this file
 * is the fake's model, `router.ts` is only translation.
 *
 * Everything here mirrors production semantics deliberately. Where it diverges it does so
 * loudly (see `docs/superpowers/specs/2026-08-22-testing-fake-design.md` — no real timing,
 * no rate limits unless injected, no webhook delivery).
 */

export interface FakeActivity {
  id: string
  actor: string
  verb: string
  object: string
  target: string | null
  foreign_id: string | null
  time: string
  custom: Record<string, unknown>
  refs: string[]
  origin_feed: string
  edited_at: string | null
  version: number
  deleted_at: string | null
}

export interface FakeObject {
  type: string
  id: string
  custom: Record<string, unknown>
  updated_at: string
}

export interface FakeNotification {
  id: string
  owner: string
  verb: 'follow' | 'react'
  actor: string
  object: string
  reaction_kind: string | null
  created_at: string
  seen_at: string | null
  read_at: string | null
}

const feedRef = (group: string, id: string) => `${group}:${id}`

/** Deterministic ids — a test that fails should fail the same way twice. */
function counter(prefix: string) {
  let n = 0
  return () => `${prefix}_${String(++n).padStart(6, '0')}`
}

export class Store {
  private readonly nextActivityId = counter('act')
  private readonly nextReactionId = counter('rct')
  private readonly nextNotificationId = counter('ntf')
  /** Monotonic stand-in for a clock, so `time` ordering is stable without sleeping. */
  private tick = 0

  /** userId → custom. Presence is what makes `actor_user` non-null. */
  readonly users = new Map<string, Record<string, unknown>>()
  /** Every activity ever written, including soft-deleted ones (the identity stays burned). */
  readonly activities: FakeActivity[] = []
  /** `group:id` → activity ids, newest first. The materialized fan-out, hard-deleted on unfollow. */
  readonly feedItems = new Map<string, string[]>()
  /** source ref → set of target refs. */
  readonly follows = new Map<string, Set<string>>()
  readonly objects = new Map<string, FakeObject>()
  /** activityId → kind → set of userIds. Counts are derived, never stored twice. */
  readonly reactions = new Map<string, Map<string, Set<string>>>()
  readonly reactionIds = new Map<string, { activityId: string; kind: string; userId: string }>()
  readonly notifications: FakeNotification[] = []

  now(): string {
    // Fixed epoch + a monotonic tick: ordering is real, wall-clock flakiness is not.
    return new Date(Date.UTC(2026, 0, 1) + this.tick++ * 1000).toISOString()
  }

  ensureUser(id: string): void {
    // Mirrors the feed service provisioning a users row on any user-token write, which is
    // why actor_user flips from null to { id, custom: {} } after someone's first post.
    if (!this.users.has(id)) this.users.set(id, {})
  }

  actorUser(actor: string): { id: string; custom: Record<string, unknown> } | null {
    if (!actor.startsWith('user:')) return null // literal prefix match, same as production
    const id = actor.slice('user:'.length)
    const custom = this.users.get(id)
    return custom === undefined ? null : { id, custom }
  }

  /** The dedupe identity. Returns a live OR soft-deleted row — the caller decides. */
  findByIdentity(foreignId: string, time: string): FakeActivity | undefined {
    return this.activities.find((a) => a.foreign_id === foreignId && a.time === time)
  }

  addActivity(a: Omit<FakeActivity, 'id' | 'version' | 'edited_at' | 'deleted_at'>): FakeActivity {
    const activity: FakeActivity = {
      ...a, id: this.nextActivityId(), version: 1, edited_at: null, deleted_at: null,
    }
    this.activities.push(activity)
    this.fanOut(activity)
    return activity
  }

  /**
   * Fan-out on write, synchronously. Every feed following the origin gets a copy, plus the
   * origin itself. No backfill: only edges that exist right now receive it, which is what
   * makes a fresh follow's timeline empty until the next post.
   */
  private fanOut(a: FakeActivity): void {
    const targets = [a.origin_feed]
    for (const [source, following] of this.follows) {
      if (following.has(a.origin_feed)) targets.push(source)
    }
    for (const t of targets) {
      const items = this.feedItems.get(t) ?? []
      items.unshift(a.id)
      this.feedItems.set(t, items)
    }
  }

  /** Soft-delete the activity, hard-delete its copies — the read path never filters. */
  removeActivity(id: string): boolean {
    const a = this.activities.find((x) => x.id === id && x.deleted_at === null)
    if (a === undefined) return false
    a.deleted_at = this.now()
    a.version++
    for (const [feed, items] of this.feedItems) {
      this.feedItems.set(feed, items.filter((i) => i !== id))
    }
    return true
  }

  follow(source: string, target: string): boolean {
    const set = this.follows.get(source) ?? new Set<string>()
    if (set.has(target)) return false // re-follow of a live edge is a no-op
    set.add(target)
    this.follows.set(source, set)
    return true
  }

  unfollow(source: string, target: string): boolean {
    const set = this.follows.get(source)
    if (set === undefined || !set.has(target)) return false
    set.delete(target)
    // Scrub the follower's copies. Synchronous here; a background job in production.
    const items = this.feedItems.get(source) ?? []
    this.feedItems.set(source, items.filter((id) => {
      const a = this.activities.find((x) => x.id === id)
      return a === undefined || a.origin_feed !== target
    }))
    return true
  }

  react(activityId: string, kind: string, userId: string): string {
    const kinds = this.reactions.get(activityId) ?? new Map<string, Set<string>>()
    const users = kinds.get(kind) ?? new Set<string>()
    users.add(userId)
    kinds.set(kind, users)
    this.reactions.set(activityId, kinds)
    const id = this.nextReactionId()
    this.reactionIds.set(id, { activityId, kind, userId })
    return id
  }

  unreact(activityId: string, kind: string, userId: string): void {
    this.reactions.get(activityId)?.get(kind)?.delete(userId)
  }

  reactionCounts(activityId: string): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [kind, users] of this.reactions.get(activityId) ?? []) {
      if (users.size > 0) out[kind] = users.size
    }
    return out
  }

  ownReactions(activityId: string, userId: string | null): string[] | undefined {
    // Keyed on caller identity, not token kind: a server token impersonating a user gets
    // it, a bare server token omits the field entirely.
    if (userId === null) return undefined
    const out: string[] = []
    for (const [kind, users] of this.reactions.get(activityId) ?? []) {
      if (users.has(userId)) out.push(kind)
    }
    return out
  }

  /** One row per (owner, verb, actor, object), forever — so a re-follow is silent. */
  notify(n: Omit<FakeNotification, 'id' | 'created_at' | 'seen_at' | 'read_at'>): void {
    const exists = this.notifications.some(
      (x) => x.owner === n.owner && x.verb === n.verb && x.actor === n.actor && x.object === n.object,
    )
    if (exists) return
    this.notifications.unshift({
      ...n, id: this.nextNotificationId(), created_at: this.now(), seen_at: null, read_at: null,
    })
  }

  feedOf(group: string, id: string): string[] {
    return this.feedItems.get(feedRef(group, id)) ?? []
  }
}

export { feedRef }
