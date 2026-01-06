import { useEffect, useMemo, useRef, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import "./App.css";

// API base should include the worker's /api prefix, e.g.:
//   local:  http://127.0.0.1:8787/api
//   remote: https://<worker>.workers.dev/api
//
// For local dev convenience, if VITE_API_BASE is not set we default to the local worker.
// In production builds (GH Pages), you should set VITE_API_BASE so the frontend calls the
// deployed worker instead of attempting same-origin requests.
const API_BASE =
  (import.meta.env.VITE_API_BASE as string) ||
  (import.meta.env.DEV ? "http://127.0.0.1:8787/api" : "");

// For GH Pages: BASE_URL is like "/topa-expert-review/"
const BASE_URL = import.meta.env.BASE_URL;
const BASENAME = BASE_URL.endsWith("/") ? BASE_URL.slice(0, -1) : BASE_URL;

// -----------------------------
// Config (change here)
// -----------------------------
const NUM_CHUNKS = 4; // <— change this to re-shard utterances across experts

// -----------------------------
// Types
// -----------------------------
type ActionSpaceMacro = {
  name: string;
  description?: string;
  goal?: string;
  states?: any;
  confidence_score?: any;
  micro_actions: Array<string | ActionSpaceMicro>;
};

type ActionSpaceMicro = {
  name: string;
  description?: string;
  states?: any;
  confidence_score?: any;
};

type ReviewRow = {
  user_idx: number;
  session_idx: number;
  utterance_id: string; // e.g. therapist_14
  context?: string;
  selected_macro_action?: string;
  selected_micro_action?: string;
  confidence_score?: number | null;
  session_summary?: string;
  presenting_conditions?: string;
  cluster_id?: number | null;
  expert_label?: string | null;
  expert_notes?: string | null;
};

type DatasetUser = {
  user_metadata?: any;
  sessions: Array<{
    session_metadata: any;
    dialogue: Array<{ speaker: string; text: string }>;
  }>;
};

type AuthState = {
  token: string;
  participant_id: string;
};

// -----------------------------
// Helpers
// -----------------------------
async function postJSON(url: string, payload: any, extraHeaders?: Record<string, string>) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(extraHeaders || {}) },
    body: JSON.stringify(payload),
  });
  const txt = await r.text();
  let j: any = null;
  try {
    j = JSON.parse(txt);
  } catch {}
  if (!r.ok) throw new Error(j?.error || txt || `HTTP ${r.status}`);
  return j;
}

// Small RFC4180-ish CSV parser (handles quotes + newlines)
function parseCSV(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let i = 0;
  let inQuotes = false;

  const pushCell = () => {
    row.push(cur);
    cur = "";
  };
  const pushRow = () => {
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          cur += '"';
          i += 2;
          continue;
        } else {
          inQuotes = false;
          i += 1;
          continue;
        }
      } else {
        cur += ch;
        i += 1;
        continue;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i += 1;
        continue;
      }
      if (ch === ",") {
        pushCell();
        i += 1;
        continue;
      }
      if (ch === "\n") {
        pushCell();
        pushRow();
        i += 1;
        continue;
      }
      if (ch === "\r") {
        // ignore
        i += 1;
        continue;
      }
      cur += ch;
      i += 1;
    }
  }
  // last cell
  pushCell();
  pushRow();

  const headers = (rows[0] || []).map((h) => h.trim());
  const out: Array<Record<string, string>> = [];
  for (let r = 1; r < rows.length; r++) {
    const rec: Record<string, string> = {};
    const rr = rows[r];
    // skip trailing empty line
    if (rr.length === 1 && rr[0].trim() === "" && headers.length === 1) continue;

    for (let c = 0; c < headers.length; c++) {
      rec[headers[c]] = (rr[c] ?? "").trim();
    }
    // guard against empty records
    const anyVal = Object.values(rec).some((v) => v !== "");
    if (anyVal) out.push(rec);
  }
  return out;
}

function toIntSafe(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function utteranceOrderKey(u: string): { speakerRank: number; idx: number } {
  // "therapist_14" or "patient_21"
  const m = /^([a-zA-Z]+)_(\d+)$/.exec(u.trim());
  if (!m) return { speakerRank: 99, idx: 1e9 };
  const sp = m[1].toLowerCase();
  const idx = parseInt(m[2], 10);
  const speakerRank = sp === "therapist" ? 0 : sp === "patient" ? 1 : 2;
  return { speakerRank, idx };
}

function buildStableSortedRows(rows: ReviewRow[]): ReviewRow[] {
  const a = [...rows];
  a.sort((x, y) => {
    if (x.user_idx !== y.user_idx) return x.user_idx - y.user_idx;
    if (x.session_idx !== y.session_idx) return x.session_idx - y.session_idx;
    const kx = utteranceOrderKey(x.utterance_id);
    const ky = utteranceOrderKey(y.utterance_id);
    if (kx.speakerRank !== ky.speakerRank) return kx.speakerRank - ky.speakerRank;
    if (kx.idx !== ky.idx) return kx.idx - ky.idx;
    return x.utterance_id.localeCompare(y.utterance_id);
  });
  return a;
}

function makeKey(r: ReviewRow) {
  return `${r.user_idx}__${r.session_idx}__${r.utterance_id}`;
}

// Map dataset speaker labels to therapist/patient
function speakerPretty(s: string): "therapist" | "patient" | "other" {
  const x = (s || "").toLowerCase();
  if (x === "system" || x === "therapist") return "therapist";
  if (x === "user" || x === "patient") return "patient";
  return "other";
}

function findSession(user: DatasetUser | null, session_idx: number) {
  if (!user) return null;
  for (const s of user.sessions || []) {
    const num = s.session_metadata?.Number;
    if (typeof num === "number" && num === session_idx) return s;
  }
  return null;
}

function buildUtteranceIdMap(session: { dialogue: Array<{ speaker: string; text: string }> }) {
  const map = new Map<string, number>(); // utterance_id -> dialogue index
  let t = 0;
  let p = 0;
  session.dialogue.forEach((d, i) => {
    const sp = speakerPretty(d.speaker);
    if (sp === "therapist") {
      map.set(`therapist_${t}`, i);
      t++;
    } else if (sp === "patient") {
      map.set(`patient_${p}`, i);
      p++;
    }
  });
  return map;
}

// -----------------------------
// Pages
// -----------------------------
function LoginPage() {
  const nav = useNavigate();
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onStart() {
    setErr(null);
    const c = code.trim();
    if (!c) return setErr("Please enter your access code.");
    setBusy(true);
    try {
      const res = await postJSON(`${API_BASE}/start`, { code: c });
      localStorage.setItem("token", res.token);
      localStorage.setItem("pid", res.participant_id);
      nav("/chunks");
    } catch (e: any) {
      setErr(e?.message || "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container">
      <div className="card">
        <h1 className="title">TOPA — Expert Review</h1>
        <p className="muted">
          Enter your access code to review low-confidence (or missing) automatic annotations.
        </p>

        <div className="row">
          <label className="label">Access code</label>
          <input
            className="input"
            placeholder="EXPERT-XXXX"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onStart()}
            disabled={busy}
          />
        </div>

        {err && <div className="alert danger">{err}</div>}

        <button className="btn primary" onClick={onStart} disabled={busy}>
          {busy ? "Checking…" : "Start"}
        </button>

        <div className="divider" />
        <p className="muted small">
          Your progress is saved automatically. You can close the tab and resume later with the same access code.
        </p>
      </div>
    </div>
  );
}

function ChunkSelectPage() {
  const nav = useNavigate();
  const token = localStorage.getItem("token") || "";
  const pid = localStorage.getItem("pid") || "";
  const [chunkId, setChunkId] = useState<number>(1);
  const [claimed, setClaimed] = useState<Set<number>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await postJSON(`${API_BASE}/chunks_status`, {});
        const s = new Set<number>();
        for (const x of res?.claimed || []) s.add(Number(x));
        setClaimed(s);
      } catch {
        // optional
      }
    })();
  }, []);

  async function onContinue() {
    setErr(null);
    if (!token) return nav("/");
    setBusy(true);
    try {
      await postJSON(`${API_BASE}/chunk_claim`, { token, chunk_id: chunkId });
      localStorage.setItem("chunk_id", String(chunkId));
      nav("/review");
    } catch (e: any) {
      setErr(e?.message || "Unable to claim chunk");
    } finally {
      setBusy(false);
    }
  }

  function onLogout() {
    localStorage.removeItem("token");
    localStorage.removeItem("pid");
    localStorage.removeItem("chunk_id");
    nav("/");
  }

  return (
    <div className="container">
      <div className="card">
        <div className="topbar">
          <div>
            <h1 className="title">Select your chunk</h1>
            <p className="muted">
              Choose a chunk to work on. Each chunk is locked to a single access code to avoid overlap.
            </p>
          </div>
          <div className="topbarActions">
            <div className="chip">ID: {pid || "—"}</div>
            <button className="btn" onClick={onLogout}>Logout</button>
          </div>
        </div>

        <div className="row">
          <label className="label">Chunk</label>
          <select
            className="select"
            value={chunkId}
            onChange={(e) => setChunkId(parseInt(e.target.value, 10))}
            disabled={busy}
          >
            {Array.from({ length: NUM_CHUNKS }, (_, i) => i + 1).map((i) => (
              <option key={i} value={i}>
                Chunk {i} {claimed.has(i) ? "(claimed)" : ""}
              </option>
            ))}
          </select>
        </div>

        {err && <div className="alert danger">{err}</div>}

        <button className="btn primary" onClick={onContinue} disabled={busy}>
          {busy ? "Claiming…" : "Continue"}
        </button>

        <div className="divider" />
        <p className="muted small">
          Change <code>NUM_CHUNKS</code> in <code>frontend/src/App.tsx</code> to reconfigure the number of chunks.
        </p>
      </div>
    </div>
  );
}

function ReviewPage() {
  const nav = useNavigate();

  const token = localStorage.getItem("token") || "";
  const pid = localStorage.getItem("pid") || "";
  const chunkId = Number(localStorage.getItem("chunk_id") || "1");

  const [macros, setMacros] = useState<ActionSpaceMacro[]>([]);
  const macroNames = useMemo(() => macros.map((m) => m.name), [macros]);

  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [dataset, setDataset] = useState<DatasetUser[] | null>(null);

  const [reviewedKeys, setReviewedKeys] = useState<Set<string>>(new Set());
  const [idx, setIdx] = useState(0);

  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // local form state
  const [macro, setMacro] = useState<string>("");
  const [micro, setMicro] = useState<string>("");
  const [microOther, setMicroOther] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const [expertConf, setExpertConf] = useState<string>(""); // "" or "1".."10"

  const [showTranscript, setShowTranscript] = useState(false);


  // load static data
  useEffect(() => {
    (async () => {
      try {
        const [aTxt, cTxt, dTxt] = await Promise.all([
          fetch(`${BASE_URL}data/action_space.json`).then((r) => r.text()),
          fetch(`${BASE_URL}data/expert_review/expert_review_micro_actions.csv`).then((r) => r.text()),
          fetch(`${BASE_URL}data/expert_review/AlexanderStreet_Dataset.json`).then((r) => r.text()),
        ]);

        const actionSpace = JSON.parse(aTxt) as ActionSpaceMacro[];
        setMacros(actionSpace || []);

        const recs = parseCSV(cTxt);
        const parsed: ReviewRow[] = recs.map((r) => ({
          user_idx: Number(r["user_idx"]),
          session_idx: Number(r["session_idx"]),
          utterance_id: r["utterance_id"],
          context: r["context"],
          selected_macro_action: r["selected_macro_action"],
          selected_micro_action: r["selected_micro_action"] || undefined,
          confidence_score: r["confidence_score"] ? Number(r["confidence_score"]) : null,
          session_summary: r["session_summary"],
          presenting_conditions: r["presenting_conditions"],
          cluster_id: r["cluster_id"] ? Number(r["cluster_id"]) : null,
          expert_label: r["expert_label"] || null,
          expert_notes: r["expert_notes"] || null,
        }));
        setRows(buildStableSortedRows(parsed));

        const ds = JSON.parse(dTxt) as DatasetUser[];
        setDataset(ds);
      } catch (e: any) {
        setErr(e?.message || "Failed to load review data");
      }
    })();
  }, []);

  // load reviewed list + progress from API, then set current index
  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const res = await postJSON(`${API_BASE}/review_list`, { token, chunk_id: chunkId });
        const s = new Set<string>();
        for (const k of res?.keys || []) s.add(String(k));
        setReviewedKeys(s);

        const p = await postJSON(`${API_BASE}/progress_get`, { token, chunk_id: chunkId });
        const pos = toIntSafe(p?.current_pos);
        if (pos !== null) setIdx(pos);
      } catch {
        // optional
      }
    })();
  }, [token, chunkId]);

  // derive chunk subset
  const chunkRows = useMemo(() => {
    const sorted = rows;
    const withChunk = sorted.map((r, globalIndex) => ({
      r,
      globalIndex,
      chunk: (globalIndex % NUM_CHUNKS) + 1,
    }));
    return withChunk.filter((x) => x.chunk === chunkId).map((x) => x.r);
  }, [rows, chunkId]);

  // Keep idx within chunkRows
  useEffect(() => {
    if (!chunkRows.length) return;
    setIdx((old) => Math.max(0, Math.min(old, chunkRows.length - 1)));
  }, [chunkRows.length]);

  // Reset form when current changes
  useEffect(() => {
    if (!chunkRows.length) return;
    const r = chunkRows[idx];
    if (!r) return;

    setErr(null);

    // Defaults: use existing expert values if already reviewed, else auto labels
    setMacro(r.selected_macro_action || "");
    setMicro((r.selected_micro_action && r.selected_micro_action !== "nan") ? r.selected_micro_action : "");
    setMicroOther("");
    setNote("");
    setExpertConf("");

    // If next unreviewed preferred, jump to first unreviewed after stored pos
    // (but only once after rows load)
  }, [idx, chunkRows]);

  // After both chunkRows and reviewedKeys exist, auto-jump to first unreviewed if idx points to reviewed
  const jumpedRef = useRef(false);
  useEffect(() => {
    if (jumpedRef.current) return;
    if (!chunkRows.length) return;
    if (reviewedKeys.size === 0) return;

    const isReviewed = (r: ReviewRow) => reviewedKeys.has(makeKey(r));
    let j = idx;
    if (j < chunkRows.length && isReviewed(chunkRows[j])) {
      const k = chunkRows.findIndex((r) => !isReviewed(r));
      if (k >= 0) j = k;
    }
    setIdx(j);
    jumpedRef.current = true;
  }, [chunkRows, reviewedKeys, idx]);

  const total = chunkRows.length;
  const cur = total ? chunkRows[idx] : null;

  const curKey = cur ? makeKey(cur) : "";
  const doneCount = useMemo(() => {
    let c = 0;
    for (const r of chunkRows) if (reviewedKeys.has(makeKey(r))) c++;
    return c;
  }, [chunkRows, reviewedKeys]);

  const microOptions = useMemo(() => {
    const m = macros.find((x) => x.name === macro);
    const base = m?.micro_actions || [];

    // action_space.json stores micro_actions as objects (with a `name` field).
    // We support both strings and objects here.
    const baseNames = base
      .map((x) => (typeof x === "string" ? x : x?.name))
      .filter((x): x is string => !!x && typeof x === "string");

    const out: string[] = ["None", ...baseNames, "Other (custom)"];

    // If the currently-selected micro isn't in the action space, keep it selectable.
    if (micro && !out.includes(micro)) out.splice(1, 0, micro);

    // de-dup
    return Array.from(new Set(out));
  }, [macros, macro, micro]);

  function ensureAuth() {
    if (!token) {
      nav("/");
      return false;
    }
    return true;
  }

  function onLogout() {
    localStorage.removeItem("token");
    localStorage.removeItem("pid");
    localStorage.removeItem("chunk_id");
    nav("/");
  }

  async function saveProgress(newPos: number) {
    try {
      await postJSON(`${API_BASE}/progress_set`, { token, chunk_id: chunkId, current_pos: newPos });
    } catch {
      // optional
    }
  }

  async function onSubmit(next: boolean) {
    if (!ensureAuth()) return;
    if (!cur) return;

    setErr(null);

    const chosenMacro = macro.trim();
    if (!chosenMacro) return setErr("Please select a macro action.");

    let chosenMicro: string | null = micro.trim();
    let chosenMicroCustom: string | null = null;

    if (chosenMicro === "Other (custom)") {
      const x = microOther.trim();
      if (!x) return setErr("Please enter your custom micro action.");
      chosenMicro = x;
      chosenMicroCustom = x;
    } else if (chosenMicro === "None") {
      chosenMicro = "None";
    } else if (!chosenMicro) {
      // allow empty micro only if macro chosen? user asked "add the label None to micro actions"
      chosenMicro = "None";
    }

    const conf = expertConf ? Number(expertConf) : null;

    setBusy(true);
    try {
      await postJSON(`${API_BASE}/review_submit`, {
        token,
        chunk_id: chunkId,
        key: curKey,
        user_idx: cur.user_idx,
        session_idx: cur.session_idx,
        utterance_id: cur.utterance_id,
        auto_macro_action: cur.selected_macro_action || null,
        auto_micro_action: cur.selected_micro_action || null,
        auto_confidence_score: cur.confidence_score ?? null,
        expert_macro_action: chosenMacro,
        expert_micro_action: chosenMicro,
        expert_micro_custom: chosenMicroCustom,
        expert_confidence_1_10: conf,
        expert_note: note.trim() ? note.trim() : null,
        timestamp_utc: new Date().toISOString(),
        page_url: window.location.href,
        user_agent: navigator.userAgent,
        current_pos: idx,
      });

      const nextSet = new Set(reviewedKeys);
      nextSet.add(curKey);
      setReviewedKeys(nextSet);

      if (next) {
        const nextIdx = Math.min(idx + 1, total - 1);
        setIdx(nextIdx);
        await saveProgress(nextIdx);
      } else {
        await saveProgress(idx);
      }
    } catch (e: any) {
      setErr(e?.message || "Failed to save review");
    } finally {
      setBusy(false);
    }
  }

  // Transcript rendering
  const transcript = useMemo(() => {
    if (!cur || !dataset) return null;
    const u = dataset[cur.user_idx];
    if (!u) return null;
    const s = findSession(u, cur.session_idx);
    if (!s) return null;

    const idMap = buildUtteranceIdMap(s);
    let targetIdx = idMap.get(cur.utterance_id);
    if (targetIdx === undefined) {
      // Fallback for 1-based indices in some CSVs: try decrementing the suffix.
      const m = /^([a-zA-Z]+)_(\d+)$/.exec(cur.utterance_id);
      if (m) {
        const n = parseInt(m[2], 10);
        if (Number.isFinite(n) && n > 0) {
          targetIdx = idMap.get(`${m[1]}_${n - 1}`);
        }
      }
    }
    if (targetIdx === undefined) return null;

    const endIdx = Math.min(targetIdx + 1, s.dialogue.length - 1); // include next utterance if exists
    const slice = s.dialogue.slice(0, endIdx + 1);

    return {
      sessionTitle: s.session_metadata?.Title || `Session ${cur.session_idx}`,
      dialogue: slice.map((d, i) => ({
        speaker: speakerPretty(d.speaker),
        text: d.text,
        isTarget: i === targetIdx,
      })),
    };
  }, [cur, dataset]);

  if (!token) return <Navigate to="/" replace />;
  if (!localStorage.getItem("chunk_id")) return <Navigate to="/chunks" replace />;

  return (
    <div className="container">
      <div className="card">
        <div className="topbar">
          <div>
            <h1 className="title">Review</h1>
            <p className="muted">
              Chunk <strong>{chunkId}</strong> · Reviewed <strong>{doneCount}</strong> / <strong>{total}</strong>
            </p>
          </div>
          <div className="topbarActions">
            <div className="chip">ID: {pid || "—"}</div>
            <button className="btn" onClick={() => nav("/chunks")}>Change chunk</button>
            <button className="btn" onClick={onLogout}>Logout</button>
          </div>
        </div>

        {err && <div className="alert danger">{err}</div>}

        {!cur && (
          <div className="alert">
            No items found for this chunk (or data failed to load).
          </div>
        )}

        {cur && (
          <>
            <div className="grid2">
              <div className="panel">
                <div className="panelHeader">
                  <h2 className="subtitle">Utterance</h2>
                  <div className="muted small">
                    {idx + 1} / {total} · <code>{curKey}</code>
                  </div>
                </div>

                <div className="meta">
                  <div><span className="metaK">user_idx</span> {cur.user_idx}</div>
                  <div><span className="metaK">session_idx</span> {cur.session_idx}</div>
                  <div><span className="metaK">utterance_id</span> {cur.utterance_id}</div>
                  <div><span className="metaK">cluster</span> {cur.cluster_id ?? "—"}</div>
                </div>

                <div className="block">
                  <div className="label">Session summary</div>
                  <div className="textBox">{cur.session_summary || <span className="muted">—</span>}</div>
                </div>

                <div className="block">
                  <div className="label">Presenting conditions</div>
                  <div className="textBox">{cur.presenting_conditions || <span className="muted">—</span>}</div>
                </div>

                <div className="block">
                  <div className="label">Context</div>
                  <pre className="pre">{cur.context || ""}</pre>
                </div>

                <div className="block rowInline">
                  <div className="chip soft">
                    Auto macro: <strong>{cur.selected_macro_action || "—"}</strong>
                  </div>
                  <div className="chip soft">
                    Auto micro: <strong>{cur.selected_micro_action || "—"}</strong>
                  </div>
                  <div className="chip soft">
                    Auto conf: <strong>{cur.confidence_score ?? "—"}</strong>
                  </div>
                </div>

                <div className="rowInline">
                  <button className="btn" onClick={() => setShowTranscript(true)} disabled={!transcript}>
                    Show transcript (start → current + next)
                  </button>
                  {!transcript && (
                    <span className="muted small">
                      Transcript not available in the provided subset.
                    </span>
                  )}
                </div>
              </div>

              <div className="panel">
                <h2 className="subtitle">Your annotation</h2>

                <div className="row">
                  <label className="label">Macro action</label>
                  <select className="select" value={macro} onChange={(e) => setMacro(e.target.value)} disabled={busy}>
                    <option value="">Select…</option>
                    {macroNames.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="row">
                  <label className="label">Micro action</label>
                  <select
                    className="select"
                    value={micro}
                    onChange={(e) => setMicro(e.target.value)}
                    disabled={busy || !macro}
                  >
                    <option value="">Select…</option>
                    {microOptions.map((x) => (
                      <option key={x} value={x}>
                        {x}
                      </option>
                    ))}
                  </select>
                </div>

                {micro === "Other (custom)" && (
                  <div className="row">
                    <label className="label">Custom micro action</label>
                    <input
                      className="input"
                      placeholder="Type your micro action…"
                      value={microOther}
                      onChange={(e) => setMicroOther(e.target.value)}
                      disabled={busy}
                    />
                  </div>
                )}

                <div className="row">
                  <label className="label">
                    Confidence (optional)
                    <span className="muted small"> · 1 (low) → 10 (high)</span>
                  </label>
                  <select
                    className="select"
                    value={expertConf}
                    onChange={(e) => setExpertConf(e.target.value)}
                    disabled={busy}
                  >
                    <option value="">—</option>
                    {Array.from({ length: 10 }, (_, i) => i + 1).map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="row">
                  <label className="label">Note (optional)</label>
                  <textarea
                    className="textarea"
                    placeholder="Any clarifications for this utterance…"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    disabled={busy}
                    rows={5}
                  />
                </div>

                <div className="rowInline">
                  <button className="btn" onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={busy || idx === 0}>
                    Prev
                  </button>
                  <button className="btn primary" onClick={() => onSubmit(false)} disabled={busy}>
                    {busy ? "Saving…" : "Save"}
                  </button>
                  <button
                    className="btn primary"
                    onClick={() => onSubmit(true)}
                    disabled={busy || idx >= total - 1}
                  >
                    {busy ? "Saving…" : "Save & Next"}
                  </button>
                </div>

                <div className="divider" />

                <div className="muted small">
                  Reviewed items are stored in the database under your access code and chunk.
                </div>
              </div>
            </div>

            {showTranscript && transcript && (
              <div className="modalBackdrop" onClick={() => setShowTranscript(false)}>
                <div className="modal" onClick={(e) => e.stopPropagation()}>
                  <div className="modalHeader">
                    <div>
                      <div className="subtitle">{transcript.sessionTitle}</div>
                      <div className="muted small">
                        Showing transcript from start to <strong>{cur.utterance_id}</strong> (+ next if exists)
                      </div>
                    </div>
                    <button className="btn" onClick={() => setShowTranscript(false)}>
                      Close
                    </button>
                  </div>
                  <div className="modalBody">
                    {transcript.dialogue.map((d, i) => (
                      <div key={i} className={`turn ${d.isTarget ? "target" : ""}`}>
                        <div className="turnSpeaker">{d.speaker}</div>
                        <div className="turnText">{d.text}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LoginPage />} />
      <Route path="/chunks" element={<ChunkSelectPage />} />
      <Route path="/review" element={<ReviewPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <div className="app">
      <BrowserRouter basename={BASENAME}>
        <AppRoutes />
      </BrowserRouter>
    </div>
  );
}
