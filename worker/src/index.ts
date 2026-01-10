export type Env = {
  DB: D1Database;
  TOKEN_SECRET: string;
  ALLOWED_ORIGINS: string; // comma-separated origins like https://USER.github.io
  ADMIN_TOKEN?: string; // optional: protects /api/admin/*
};

const JSON_HEADERS = { "Content-Type": "application/json" };

const LEASE_MS = 24 * 60 * 60 * 1000; // 1 day inactivity lease timeout

function normalizeEmail(raw: string) {
  return String(raw || "").trim().toLowerCase();
}

function looksLikeEmail(email: string) {
  // Lightweight check; we don't need strict RFC validation here.
  return /.+@.+\..+/.test(email);
}

function cors(origin: string) {
  return {
    ...JSON_HEADERS,
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Admin-Token",
    "Access-Control-Max-Age": "86400",
  };
}

function isAllowedOrigin(env: Env, origin: string) {
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(origin);
}

function toB64Json(obj: any) {
  const s = JSON.stringify(obj);
  const b = new TextEncoder().encode(s);
  return btoa(String.fromCharCode(...b));
}

function fromB64Json(b64: string) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const s = new TextDecoder().decode(bytes);
  return JSON.parse(s);
}

async function hmacSign(secret: string, body: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const bytes = new Uint8Array(sig);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function makeToken(env: Env, payload: any) {
  const body = toB64Json(payload);
  const sig = await hmacSign(env.TOKEN_SECRET, body);
  return `${body}.${sig}`;
}

async function verifyToken(env: Env, token: string) {
  const [body, sig] = token.split(".");
  if (!body || !sig) throw new Error("Bad token format");
  const expected = await hmacSign(env.TOKEN_SECRET, body);
  if (expected !== sig) throw new Error("Bad token signature");
  const payload = fromB64Json(body);
  if (payload.exp && Date.now() > payload.exp) throw new Error("Token expired");
  return payload;
}

async function sha256Hex(s: string) {
  const bytes = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const arr = new Uint8Array(hash);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---- D1 helpers ----
type AccessCodeRow = {
  code_hash: string;
  active: number;
  uses_remaining: number | null;
  expires_at: string | null;
};

async function dbGetAccessCode(env: Env, codeHash: string): Promise<AccessCodeRow | null> {
  const row = await env.DB
    .prepare("SELECT code_hash, active, uses_remaining, expires_at FROM access_codes WHERE code_hash = ?")
    .bind(codeHash)
    .first<AccessCodeRow>();
  return row ?? null;
}

async function dbDecrementUsesRemaining(env: Env, codeHash: string) {
  await env.DB
    .prepare("UPDATE access_codes SET uses_remaining = uses_remaining - 1 WHERE code_hash = ? AND uses_remaining IS NOT NULL")
    .bind(codeHash)
    .run();
}

async function allocateParticipantId(env: Env) {
  const now = new Date().toISOString();
  const res = await env.DB.prepare("INSERT INTO participants(created_at) VALUES (?)").bind(now).run();
  const idNum = Number(res.meta.last_row_id);
  return `P${String(idNum).padStart(5, "0")}`;
}

// --- Chunk claims ---
async function getOrCreateParticipantIdByEmail(env: Env, emailNorm: string) {
  // Try to reuse participant id for returning experts.
  // Falls back to allocating a new id if the DB schema is older (no email column).
  try {
    const row = await env.DB
      .prepare("SELECT id FROM participants WHERE lower(email) = ? LIMIT 1")
      .bind(emailNorm)
      .first<{ id: number }>();
    if (row?.id) return `P${String(row.id).padStart(5, "0")}`;
    const now = new Date().toISOString();
    const res = await env.DB
      .prepare("INSERT INTO participants(created_at, email, updated_at) VALUES (?,?,?)")
      .bind(now, emailNorm, now)
      .run();
    const idNum = Number(res.meta.last_row_id);
    return `P${String(idNum).padStart(5, "0")}`;
  } catch {
    // Legacy schema: allocate without email.
    return await allocateParticipantId(env);
  }
}


type ChunkClaimRow = {
  chunk_id: number;
  claimed_at: string;
  updated_at: string;
  email?: string | null;
  email_hash?: string | null;
  has_progress?: number | null;
};

async function dbGetChunkClaim(env: Env, chunkId: number): Promise<ChunkClaimRow | null> {
  const row = await env.DB
    .prepare("SELECT chunk_id, claimed_at, updated_at, email, email_hash, has_progress FROM chunk_claims WHERE chunk_id = ?")
    .bind(chunkId)
    .first<ChunkClaimRow>();
  return row ?? null;
}

async function dbGetClaimByEmailHash(env: Env, emailHash: string): Promise<ChunkClaimRow | null> {
  try {
    const row = await env.DB
      .prepare(
        "SELECT chunk_id, claimed_at, updated_at, email, email_hash, has_progress FROM chunk_claims WHERE email_hash = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .bind(emailHash)
      .first<ChunkClaimRow>();
    return row || null;
  } catch {
    return null;
  }
}

async function dbClaimChunk(env: Env, chunkId: number, codeHash: string, email: string, emailHash: string) {
  const nowIso = new Date().toISOString();
  const expiryIso = new Date(Date.now() - LEASE_MS).toISOString();

  try {
    const res = await env.DB
      .prepare(
        `INSERT INTO chunk_claims(chunk_id, code_hash, email, email_hash, claimed_at, updated_at, has_progress)
         VALUES (?,?,?,?,?,?,0)
         ON CONFLICT(chunk_id) DO UPDATE SET
           email=excluded.email,
           email_hash=excluded.email_hash,
           code_hash=excluded.code_hash,
           claimed_at=CASE
             WHEN chunk_claims.email_hash = excluded.email_hash THEN chunk_claims.claimed_at
             ELSE excluded.claimed_at
           END,
           updated_at=excluded.updated_at,
           has_progress=CASE
             WHEN chunk_claims.email_hash = excluded.email_hash THEN chunk_claims.has_progress
             ELSE 0
           END
         WHERE
           chunk_claims.email_hash = excluded.email_hash
           OR (chunk_claims.has_progress = 0 AND (chunk_claims.updated_at IS NULL OR chunk_claims.updated_at < ?))
        `,
      )
      .bind(chunkId, codeHash, email, emailHash, nowIso, nowIso, expiryIso)
      .run();

    if (Number(res.meta.changes) > 0) return;

    const existing = await dbGetChunkClaim(env, chunkId);
    if (existing) {
      const e: any = new Error(
        existing.has_progress ? "Chunk is locked (review already started by another expert)" : "Chunk is currently reserved by another expert",
      );
      e.status = 409;
      throw e;
    }
    const e: any = new Error("Unable to claim chunk");
    e.status = 409;
    throw e;
  } catch (err: any) {
    // Most common dev issue: schema not migrated yet.
    if ((err?.message || "").includes("no such column") || (err?.message || "").includes("has_progress")) {
      const e: any = new Error("DB schema is out of date. Apply the latest D1 migrations, then retry.");
      e.status = 500;
      throw e;
    }
    throw err;
  }
}

type ChunkClaimBrief = { chunk_id: number; email_hash?: string | null; updated_at?: string | null; has_progress?: number | null };

async function dbListChunkClaims(env: Env): Promise<ChunkClaimBrief[]> {
  try {
    const res = await env.DB
      .prepare("SELECT chunk_id, email_hash, updated_at, has_progress FROM chunk_claims")
      .all<ChunkClaimBrief>();
    return (res.results || []).map((r) => ({
      chunk_id: Number(r.chunk_id),
      email_hash: (r as any).email_hash ?? null,
      updated_at: (r as any).updated_at ?? null,
      has_progress: (r as any).has_progress ?? 0,
    }));
  } catch {
    // Legacy schema
    const res = await env.DB.prepare("SELECT chunk_id FROM chunk_claims").all<{ chunk_id: number }>();
    return (res.results || []).map((r) => ({ chunk_id: Number(r.chunk_id) }));
  }
}

async function dbListClaimedChunks(env: Env): Promise<number[]> {
  const claims = await dbListChunkClaims(env);
  return claims.map((c) => c.chunk_id);
}

// --- Reviews ---
async function dbUpsertReview(env: Env, row: any) {
  await env.DB.prepare(
    `INSERT INTO utterance_reviews (
        id, code_hash, chunk_id, item_key,
        user_idx, session_idx, utterance_id,
        auto_macro_action, auto_micro_action, auto_confidence_score,
        expert_macro_action, expert_micro_action, expert_micro_custom, expert_micro_custom_desc,
        expert_confidence_1_10, expert_note,
        reviewer_email, reviewer_hash,
        timestamp_utc, user_agent, page_url,
        reviewed_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        auto_macro_action=excluded.auto_macro_action,
        auto_micro_action=excluded.auto_micro_action,
        auto_confidence_score=excluded.auto_confidence_score,
        expert_macro_action=excluded.expert_macro_action,
        expert_micro_action=excluded.expert_micro_action,
        expert_micro_custom=excluded.expert_micro_custom,
        expert_micro_custom_desc=excluded.expert_micro_custom_desc,
        expert_confidence_1_10=excluded.expert_confidence_1_10,
        expert_note=excluded.expert_note,
        reviewer_email=excluded.reviewer_email,
        reviewer_hash=excluded.reviewer_hash,
        timestamp_utc=excluded.timestamp_utc,
        user_agent=excluded.user_agent,
        page_url=excluded.page_url,
        reviewed_at=excluded.reviewed_at
    `,
  )
    .bind(
      row.id,
      row.code_hash,
      row.chunk_id,
      row.item_key,
      row.user_idx,
      row.session_idx,
      row.utterance_id,
      row.auto_macro_action,
      row.auto_micro_action,
      row.auto_confidence_score,
      row.expert_macro_action,
      row.expert_micro_action,
      row.expert_micro_custom,
      row.expert_micro_custom_desc,
      row.expert_confidence_1_10,
      row.expert_note,
      row.reviewer_email,
      row.reviewer_hash,
      row.timestamp_utc,
      row.user_agent,
      row.page_url,
      row.reviewed_at,
    )
    .run();
}

async function dbListReviewedKeys(env: Env, reviewerHash: string, chunkId: number): Promise<string[]> {
  const res = await env.DB
    .prepare("SELECT item_key FROM utterance_reviews WHERE reviewer_hash = ? AND chunk_id = ?")
    .bind(reviewerHash, chunkId)
    .all<{ item_key: string }>();
  return (res.results || []).map((r) => r.item_key);
}

async function dbTouchClaim(env: Env, chunkId: number, reviewerHash: string) {
  const now = new Date().toISOString();
  try {
    await env.DB
      .prepare("UPDATE chunk_claims SET updated_at = ? WHERE chunk_id = ? AND email_hash = ?")
      .bind(now, chunkId, reviewerHash)
      .run();
  } catch {
    // optional
  }
}

async function dbMarkClaimProgress(env: Env, chunkId: number, reviewerHash: string) {
  const now = new Date().toISOString();
  try {
    await env.DB
      .prepare("UPDATE chunk_claims SET has_progress = 1, updated_at = ? WHERE chunk_id = ? AND email_hash = ?")
      .bind(now, chunkId, reviewerHash)
      .run();
  } catch {
    // optional
  }
}

// --- Progress ---
type ProgressRow = { reviewer_hash: string; chunk_id: number; current_pos: number; updated_at: string };

async function dbSetProgress(env: Env, reviewerHash: string, chunkId: number, currentPos: number) {
  const now = new Date().toISOString();
  await env.DB
    .prepare(
      `INSERT INTO expert_progress_v2 (reviewer_hash, chunk_id, current_pos, updated_at)
       VALUES (?,?,?,?)
       ON CONFLICT(reviewer_hash, chunk_id) DO UPDATE SET
         current_pos=excluded.current_pos,
         updated_at=excluded.updated_at
      `,
    )
    .bind(reviewerHash, chunkId, currentPos, now)
    .run();
}

async function dbGetProgress(env: Env, reviewerHash: string, chunkId: number): Promise<ProgressRow | null> {
  const row = await env.DB
    .prepare("SELECT reviewer_hash, chunk_id, current_pos, updated_at FROM expert_progress_v2 WHERE reviewer_hash = ? AND chunk_id = ?")
    .bind(reviewerHash, chunkId)
    .first<ProgressRow>();
  return row ?? null;
}

// --- Admin: register code ---
async function requireAdmin(env: Env, req: Request) {
  const token = req.headers.get("X-Admin-Token") || "";
  if (!env.ADMIN_TOKEN) {
    const e: any = new Error("Admin is not configured (missing ADMIN_TOKEN)");
    e.status = 403;
    throw e;
  }
  if (token !== env.ADMIN_TOKEN) {
    const e: any = new Error("Forbidden");
    e.status = 403;
    throw e;
  }
}

export default {
  async fetch(req: Request, env: Env) {
    const origin = req.headers.get("Origin") || "";
    if (!origin) return new Response(JSON.stringify({ error: "Missing Origin" }), { status: 403, headers: JSON_HEADERS });
    if (!isAllowedOrigin(env, origin)) {
      return new Response(JSON.stringify({ error: "Origin not allowed" }), { status: 403, headers: cors(origin) });
    }

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: cors(origin) });

    const url = new URL(req.url);
    const path = url.pathname;
    const headers = cors(origin);

    try {
      // POST /api/start
      if (path.endsWith("/api/start")) {
        const body = await req.json().catch(() => ({}));
        const code = String(body.code || "").trim();
        const emailNorm = normalizeEmail(body.email || "");
        if (!code) return new Response(JSON.stringify({ error: "Missing code" }), { status: 400, headers });
        if (!emailNorm) return new Response(JSON.stringify({ error: "Missing email" }), { status: 400, headers });
        if (!looksLikeEmail(emailNorm)) return new Response(JSON.stringify({ error: "Invalid email" }), { status: 400, headers });

        const codeHash = await sha256Hex(code);
        const doc = await dbGetAccessCode(env, codeHash);
        if (!doc) return new Response(JSON.stringify({ error: "Invalid code" }), { status: 403, headers });
        if (doc.active !== 1) return new Response(JSON.stringify({ error: "Code inactive" }), { status: 403, headers });

        if (doc.uses_remaining !== null && doc.uses_remaining <= 0) {
          return new Response(JSON.stringify({ error: "Code has no remaining uses" }), { status: 403, headers });
        }

        if (doc.expires_at) {
          const expMs = Date.parse(doc.expires_at);
          if (!Number.isFinite(expMs)) return new Response(JSON.stringify({ error: "Bad expires_at format in DB" }), { status: 500, headers });
          if (Date.now() > expMs) return new Response(JSON.stringify({ error: "Code expired" }), { status: 403, headers });
        }

        if (doc.uses_remaining !== null) await dbDecrementUsesRemaining(env, codeHash);

        const participant_id = await getOrCreateParticipantIdByEmail(env, emailNorm);
        const emailHash = await sha256Hex(emailNorm);
        const token = await makeToken(env, {
          participant_id,
          codeHash,
          email: emailNorm,
          emailHash,
          iat: Date.now(),
          exp: Date.now() + 1000 * 60 * 60 * 24 * 7,
        });

        const lastClaim = await dbGetClaimByEmailHash(env, emailHash);
        const assigned_chunk = lastClaim ? Number(lastClaim.chunk_id) : null;
        return new Response(JSON.stringify({ ok: true, token, participant_id, assigned_chunk }), { status: 200, headers });
      }

      // POST /api/chunks_status  (auth optional)
      if (path.endsWith("/api/chunks_status")) {
        const body: any = await req.json().catch(() => ({}));
        let mine: number[] = [];
        let myHash: string | null = null;
        if (body?.token) {
          try {
            const payload = await verifyToken(env, String(body.token));
            myHash = String(payload.emailHash || "");
          } catch {
            myHash = null;
          }
        }
        const claims = await dbListChunkClaims(env);
        const nowMs = Date.now();
        const activeClaims = claims.filter((c) => {
          const hasProgress = Number((c as any).has_progress ?? 0) === 1;
          if (hasProgress) return true;
          const updatedAt = (c as any).updated_at ? Date.parse(String((c as any).updated_at)) : NaN;
          if (!Number.isFinite(updatedAt)) return true; // be conservative
          return nowMs - updatedAt <= LEASE_MS;
        });
        const claimed = activeClaims.map((c) => Number(c.chunk_id));
        if (myHash) {
          mine = activeClaims.filter((c) => (c.email_hash || "") === myHash).map((c) => Number(c.chunk_id));
        }
        return new Response(JSON.stringify({ ok: true, claimed, mine }), { status: 200, headers });
      }

      // POST /api/chunk_claim  (auth)
      if (path.endsWith("/api/chunk_claim")) {
        const body: any = await req.json().catch(() => ({}));
        const token = String(body.token || "");
        const chunkId = Number(body.chunk_id);
        if (!token || !Number.isFinite(chunkId)) {
          return new Response(JSON.stringify({ error: "Missing token or chunk_id" }), { status: 400, headers });
        }
        const payload = await verifyToken(env, token);
        if (!payload.codeHash) return new Response(JSON.stringify({ error: "Missing code context" }), { status: 401, headers });
        await dbClaimChunk(env, chunkId, String(payload.codeHash || ""), payload.email, payload.emailHash);
        return new Response(JSON.stringify({ ok: true, assigned_chunk: chunkId }), { status: 200, headers });
      }

      // POST /api/claim_heartbeat (auth)
if (path.endsWith("/api/claim_heartbeat")) {
  const body: any = await req.json().catch(() => ({}));
  if (!body?.token) return new Response(JSON.stringify({ error: "Missing token" }), { status: 400, headers });
  const payload = await verifyToken(env, String(body.token));
  const chunkId = Number(body.chunk_id);
  if (!Number.isFinite(chunkId)) return new Response(JSON.stringify({ error: "Missing chunk_id" }), { status: 400, headers });
  await dbTouchClaim(env, chunkId, String(payload.emailHash || ""));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

// POST /api/review_submit (auth)
      if (path.endsWith("/api/review_submit")) {
        const body: any = await req.json().catch(() => ({}));
        if (!body?.token) return new Response(JSON.stringify({ error: "Missing token" }), { status: 400, headers });
        const payload = await verifyToken(env, String(body.token));

        const chunkId = Number(body.chunk_id);
        // Require the chunk to be claimed by this email (prevents shared access code collisions)
        const claim = await dbGetChunkClaim(env, chunkId);
        if (!claim || !String(claim.email_hash || "")) {
          return new Response(JSON.stringify({ error: "Chunk must be claimed before submitting a review" }), { status: 403, headers });
        }
        if (String(claim.email_hash || "") !== String(payload.emailHash || "")) {
          return new Response(JSON.stringify({ error: "Chunk is claimed by another expert" }), { status: 403, headers });
        }

        const itemKey = String(body.key || "").trim();
        const userIdx = Number(body.user_idx);
        const sessionIdx = Number(body.session_idx);
        const utteranceId = String(body.utterance_id || "").trim();

        const expertMacro = String(body.expert_macro_action || "").trim();
        const expertMicro = String(body.expert_micro_action || "").trim();
        const expertMicroCustom = body.expert_micro_custom ? String(body.expert_micro_custom).trim() : null;
        const expertMicroCustomDesc = body.expert_micro_custom_desc ? String(body.expert_micro_custom_desc).trim() : null;
        if (expertMicro === "Other (custom)" && !expertMicroCustom) {
          return new Response(JSON.stringify({ error: "Missing expert_micro_custom" }), { status: 400, headers });
        }
        if (expertMicroCustom && !expertMicroCustomDesc) {
          return new Response(JSON.stringify({ error: "Missing expert_micro_custom_desc" }), { status: 400, headers });
        }

        if (!Number.isFinite(chunkId) || !itemKey || !Number.isFinite(userIdx) || !Number.isFinite(sessionIdx) || !utteranceId) {
          return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400, headers });
        }
        if (!expertMacro) return new Response(JSON.stringify({ error: "expert_macro_action is required" }), { status: 400, headers });
        if (!expertMicro) return new Response(JSON.stringify({ error: "expert_micro_action is required" }), { status: 400, headers });

        // enforce chunk lock
        await dbClaimChunk(env, chunkId, String(payload.codeHash || ""), payload.email, payload.emailHash);

        const reviewedAt = new Date().toISOString();
        const id = `${payload.emailHash}__${chunkId}__${itemKey}`;

        await dbUpsertReview(env, {
          id,
          code_hash: payload.codeHash,
          chunk_id: chunkId,
          item_key: itemKey,
          user_idx: userIdx,
          session_idx: sessionIdx,
          utterance_id: utteranceId,
          auto_macro_action: body.auto_macro_action ?? null,
          auto_micro_action: body.auto_micro_action ?? null,
          auto_confidence_score: body.auto_confidence_score ?? null,
          expert_macro_action: expertMacro,
          expert_micro_action: expertMicro,
          expert_micro_custom: expertMicroCustom,
          expert_micro_custom_desc: expertMicroCustomDesc,
          expert_confidence_1_10: body.expert_confidence_1_10 ?? null,
          expert_note: body.expert_note ?? null,
          reviewer_email: payload.email ?? null,
          reviewer_hash: payload.emailHash ?? null,
          timestamp_utc: body.timestamp_utc ?? reviewedAt,
          user_agent: body.user_agent ?? null,
          page_url: body.page_url ?? null,
          reviewed_at: reviewedAt,
        });

        await dbMarkClaimProgress(env, chunkId, String(payload.emailHash || ""));

        // progress (optional)
        if (Number.isFinite(Number(body.current_pos))) {
          await dbSetProgress(env, String(payload.emailHash || ""), chunkId, Number(body.current_pos));
        }

        return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
      }

      // POST /api/review_list (auth)
      if (path.endsWith("/api/review_list")) {
        const body: any = await req.json().catch(() => ({}));
        if (!body?.token) return new Response(JSON.stringify({ error: "Missing token" }), { status: 400, headers });
        const payload = await verifyToken(env, String(body.token));
        const chunkId = Number(body.chunk_id);
        if (!Number.isFinite(chunkId)) return new Response(JSON.stringify({ error: "Missing chunk_id" }), { status: 400, headers });

        const keys = await dbListReviewedKeys(env, String(payload.emailHash || ""), chunkId);
        return new Response(JSON.stringify({ ok: true, keys }), { status: 200, headers });
      }

      // POST /api/progress_set (auth)
      if (path.endsWith("/api/progress_set")) {
        const body: any = await req.json().catch(() => ({}));
        if (!body?.token) return new Response(JSON.stringify({ error: "Missing token" }), { status: 400, headers });
        const payload = await verifyToken(env, String(body.token));
        const chunkId = Number(body.chunk_id);
        const currentPos = Number(body.current_pos);
        if (!Number.isFinite(chunkId) || !Number.isFinite(currentPos)) {
          return new Response(JSON.stringify({ error: "Missing chunk_id or current_pos" }), { status: 400, headers });
        }
        await dbSetProgress(env, String(payload.emailHash || ""), chunkId, currentPos);
        await dbTouchClaim(env, chunkId, String(payload.emailHash || ""));
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
      }

      // POST /api/progress_get (auth)
      if (path.endsWith("/api/progress_get")) {
        const body: any = await req.json().catch(() => ({}));
        if (!body?.token) return new Response(JSON.stringify({ error: "Missing token" }), { status: 400, headers });
        const payload = await verifyToken(env, String(body.token));
        const chunkId = Number(body.chunk_id);
        if (!Number.isFinite(chunkId)) return new Response(JSON.stringify({ error: "Missing chunk_id" }), { status: 400, headers });

        const p = await dbGetProgress(env, String(payload.emailHash || ""), chunkId);
        return new Response(JSON.stringify({ ok: true, ...(p || {}) }), { status: 200, headers });
      }

      // POST /api/admin/register_code (admin)
      if (path.endsWith("/api/admin/register_code")) {
        await requireAdmin(env, req);
        const body: any = await req.json().catch(() => ({}));
        const code = String(body.code || "").trim();
        const emailNorm = normalizeEmail(body.email || "");
        if (!code) return new Response(JSON.stringify({ error: "Missing code" }), { status: 400, headers });
        if (!emailNorm) return new Response(JSON.stringify({ error: "Missing email" }), { status: 400, headers });
        if (!looksLikeEmail(emailNorm)) return new Response(JSON.stringify({ error: "Invalid email" }), { status: 400, headers });

        const uses = body.uses_remaining === undefined || body.uses_remaining === null ? null : Number(body.uses_remaining);
        const expiresAt = body.expires_at ? String(body.expires_at) : null;

        const codeHash = await sha256Hex(code);
        await env.DB
          .prepare(
            `INSERT OR REPLACE INTO access_codes(code_hash, active, uses_remaining, expires_at, created_at)
             VALUES(?, 1, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
          )
          .bind(codeHash, uses, expiresAt)
          .run();

        return new Response(JSON.stringify({ ok: true, code_hash: codeHash }), { status: 200, headers });
      }

      return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers });
    } catch (e: any) {
      const status = e?.status || 500;
      const out: any = { error: e?.message || "Internal error" };
      if (Number.isFinite(e?.assigned_chunk)) out.assigned_chunk = e.assigned_chunk;
      return new Response(JSON.stringify(out), { status, headers });
    }
  },
};
