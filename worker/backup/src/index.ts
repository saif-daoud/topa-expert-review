export type Env = {
  DB: D1Database;
  TOKEN_SECRET: string;
  ALLOWED_ORIGINS: string; // comma-separated origins like https://USER.github.io
  ADMIN_TOKEN?: string; // optional: protects /api/admin/*
};

const JSON_HEADERS = { "Content-Type": "application/json" };

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
type ChunkClaimRow = { chunk_id: number; code_hash: string; claimed_at: string; updated_at: string };

async function dbGetChunkClaim(env: Env, chunkId: number): Promise<ChunkClaimRow | null> {
  const row = await env.DB
    .prepare("SELECT chunk_id, code_hash, claimed_at, updated_at FROM chunk_claims WHERE chunk_id = ?")
    .bind(chunkId)
    .first<ChunkClaimRow>();
  return row ?? null;
}

async function dbClaimChunk(env: Env, chunkId: number, codeHash: string) {
  const now = new Date().toISOString();
  // If already claimed, only allow same codeHash
  const existing = await dbGetChunkClaim(env, chunkId);
  if (existing && existing.code_hash !== codeHash) {
    const e: any = new Error("Chunk is already claimed by another access code");
    e.status = 409;
    throw e;
  }
  if (existing) {
    await env.DB
      .prepare("UPDATE chunk_claims SET updated_at = ? WHERE chunk_id = ?")
      .bind(now, chunkId)
      .run();
    return;
  }
  await env.DB
    .prepare("INSERT INTO chunk_claims(chunk_id, code_hash, claimed_at, updated_at) VALUES (?,?,?,?)")
    .bind(chunkId, codeHash, now, now)
    .run();
}

async function dbListClaimedChunks(env: Env): Promise<number[]> {
  const res = await env.DB.prepare("SELECT chunk_id FROM chunk_claims").all<{ chunk_id: number }>();
  return (res.results || []).map((r) => Number(r.chunk_id));
}

// --- Reviews ---
async function dbUpsertReview(env: Env, row: any) {
  await env.DB.prepare(
    `INSERT INTO utterance_reviews (
        id, code_hash, chunk_id, item_key,
        user_idx, session_idx, utterance_id,
        auto_macro_action, auto_micro_action, auto_confidence_score,
        expert_macro_action, expert_micro_action, expert_micro_custom,
        expert_confidence_1_10, expert_note,
        timestamp_utc, user_agent, page_url,
        reviewed_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        auto_macro_action=excluded.auto_macro_action,
        auto_micro_action=excluded.auto_micro_action,
        auto_confidence_score=excluded.auto_confidence_score,
        expert_macro_action=excluded.expert_macro_action,
        expert_micro_action=excluded.expert_micro_action,
        expert_micro_custom=excluded.expert_micro_custom,
        expert_confidence_1_10=excluded.expert_confidence_1_10,
        expert_note=excluded.expert_note,
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
      row.expert_confidence_1_10,
      row.expert_note,
      row.timestamp_utc,
      row.user_agent,
      row.page_url,
      row.reviewed_at,
    )
    .run();
}

async function dbListReviewedKeys(env: Env, codeHash: string, chunkId: number): Promise<string[]> {
  const res = await env.DB
    .prepare("SELECT item_key FROM utterance_reviews WHERE code_hash = ? AND chunk_id = ?")
    .bind(codeHash, chunkId)
    .all<{ item_key: string }>();
  return (res.results || []).map((r) => r.item_key);
}

// --- Progress ---
type ProgressRow = { code_hash: string; chunk_id: number; current_pos: number; updated_at: string };

async function dbSetProgress(env: Env, codeHash: string, chunkId: number, currentPos: number) {
  const now = new Date().toISOString();
  await env.DB
    .prepare(
      `INSERT INTO expert_progress (code_hash, chunk_id, current_pos, updated_at)
       VALUES (?,?,?,?)
       ON CONFLICT(code_hash, chunk_id) DO UPDATE SET
         current_pos=excluded.current_pos,
         updated_at=excluded.updated_at
      `,
    )
    .bind(codeHash, chunkId, currentPos, now)
    .run();
}

async function dbGetProgress(env: Env, codeHash: string, chunkId: number): Promise<ProgressRow | null> {
  const row = await env.DB
    .prepare("SELECT code_hash, chunk_id, current_pos, updated_at FROM expert_progress WHERE code_hash = ? AND chunk_id = ?")
    .bind(codeHash, chunkId)
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
        if (!code) return new Response(JSON.stringify({ error: "Missing code" }), { status: 400, headers });

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

        const participant_id = await allocateParticipantId(env);
        const token = await makeToken(env, {
          codeHash,
          participant_id,
          exp: Date.now() + 12 * 60 * 60 * 1000,
        });

        return new Response(JSON.stringify({ ok: true, token, participant_id }), { status: 200, headers });
      }

      // POST /api/chunks_status  (no auth)
      if (path.endsWith("/api/chunks_status")) {
        const claimed = await dbListClaimedChunks(env);
        return new Response(JSON.stringify({ ok: true, claimed }), { status: 200, headers });
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
        await dbClaimChunk(env, chunkId, payload.codeHash);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
      }

      // POST /api/review_submit (auth)
      if (path.endsWith("/api/review_submit")) {
        const body: any = await req.json().catch(() => ({}));
        if (!body?.token) return new Response(JSON.stringify({ error: "Missing token" }), { status: 400, headers });
        const payload = await verifyToken(env, String(body.token));

        const chunkId = Number(body.chunk_id);
        const itemKey = String(body.key || "").trim();
        const userIdx = Number(body.user_idx);
        const sessionIdx = Number(body.session_idx);
        const utteranceId = String(body.utterance_id || "").trim();

        const expertMacro = String(body.expert_macro_action || "").trim();
        const expertMicro = String(body.expert_micro_action || "").trim();

        if (!Number.isFinite(chunkId) || !itemKey || !Number.isFinite(userIdx) || !Number.isFinite(sessionIdx) || !utteranceId) {
          return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400, headers });
        }
        if (!expertMacro) return new Response(JSON.stringify({ error: "expert_macro_action is required" }), { status: 400, headers });
        if (!expertMicro) return new Response(JSON.stringify({ error: "expert_micro_action is required" }), { status: 400, headers });

        // enforce chunk lock
        await dbClaimChunk(env, chunkId, payload.codeHash);

        const reviewedAt = new Date().toISOString();
        const id = `${payload.codeHash}__${chunkId}__${itemKey}`;

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
          expert_micro_custom: body.expert_micro_custom ?? null,
          expert_confidence_1_10: body.expert_confidence_1_10 ?? null,
          expert_note: body.expert_note ?? null,
          timestamp_utc: body.timestamp_utc ?? reviewedAt,
          user_agent: body.user_agent ?? null,
          page_url: body.page_url ?? null,
          reviewed_at: reviewedAt,
        });

        // progress (optional)
        if (Number.isFinite(Number(body.current_pos))) {
          await dbSetProgress(env, payload.codeHash, chunkId, Number(body.current_pos));
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

        const keys = await dbListReviewedKeys(env, payload.codeHash, chunkId);
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
        await dbSetProgress(env, payload.codeHash, chunkId, currentPos);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
      }

      // POST /api/progress_get (auth)
      if (path.endsWith("/api/progress_get")) {
        const body: any = await req.json().catch(() => ({}));
        if (!body?.token) return new Response(JSON.stringify({ error: "Missing token" }), { status: 400, headers });
        const payload = await verifyToken(env, String(body.token));
        const chunkId = Number(body.chunk_id);
        if (!Number.isFinite(chunkId)) return new Response(JSON.stringify({ error: "Missing chunk_id" }), { status: 400, headers });

        const p = await dbGetProgress(env, payload.codeHash, chunkId);
        return new Response(JSON.stringify({ ok: true, ...(p || {}) }), { status: 200, headers });
      }

      // POST /api/admin/register_code (admin)
      if (path.endsWith("/api/admin/register_code")) {
        await requireAdmin(env, req);
        const body: any = await req.json().catch(() => ({}));
        const code = String(body.code || "").trim();
        if (!code) return new Response(JSON.stringify({ error: "Missing code" }), { status: 400, headers });

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
      return new Response(JSON.stringify({ error: e?.message || "Internal error" }), { status, headers });
    }
  },
};
