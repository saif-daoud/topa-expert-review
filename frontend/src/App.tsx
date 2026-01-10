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
const NUM_CHUNKS = 20;

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


// -----------------------------
// Helpers
// -----------------------------
async function postJSON(
  url: string,
  payload: any,
  extraHeaders?: Record<string, string>,
  opts?: { keepalive?: boolean; signal?: AbortSignal },
) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(extraHeaders || {}) },
    body: JSON.stringify(payload),
    keepalive: opts?.keepalive,
    signal: opts?.signal,
  });
  const txt = await r.text();
  let j: any = null;
  try {
    j = JSON.parse(txt);
  } catch {}
  if (!r.ok) {
    const err: any = new Error(j?.error || txt || `HTTP ${r.status}`);
    err.status = r.status;
    if (j && typeof j === "object") {
      err.data = j;
      if (Number.isFinite((j as any).assigned_chunk)) err.assigned_chunk = (j as any).assigned_chunk;
    }
    throw err;
  }
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

type HoverSelectOption = {
  name: string;
  description?: string;
};

function HoverSelect({
  value,
  options,
  placeholder = "Select…",
  disabled,
  onChange,
  ariaLabel,
}: {
  value: string;
  options: HoverSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  onChange: (next: string) => void;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hoverIdx, setHoverIdx] = useState<number>(-1);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const selected = useMemo(() => options.find((o) => o.name === value) || null, [options, value]);
  const selectedDesc = (selected?.description || "").trim();

  useEffect(() => {
    if (!open) return;

    // initialize hover target
    const idx = value ? options.findIndex((o) => o.name === value) : 0;
    setHoverIdx(idx >= 0 ? idx : 0);

    // focus the menu for keyboard navigation
    requestAnimationFrame(() => menuRef.current?.focus());

    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (menuRef.current?.contains(t)) return;
      if (btnRef.current?.contains(t)) return;
      setOpen(false);
    };

    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open, options, value]);

  const active = (hoverIdx >= 0 ? options[hoverIdx] : null) || null;
  const activeDesc = (active?.description || "").trim();

  const label = value ? value : placeholder;

  const chooseIdx = (idx: number) => {
    const opt = options[idx];
    if (!opt) return;
    onChange(opt.name);
    setOpen(false);
    requestAnimationFrame(() => btnRef.current?.focus());
  };

  const onButtonKeyDown = (e: any) => {
    if (disabled) return;
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onMenuKeyDown = (e: any) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHoverIdx((i) => Math.min(options.length - 1, (i < 0 ? 0 : i + 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHoverIdx((i) => Math.max(0, (i < 0 ? 0 : i - 1)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (hoverIdx >= 0) chooseIdx(hoverIdx);
    }
  };

  return (
    <div className={"hoverSelect" + (disabled ? " isDisabled" : "")}
         aria-label={ariaLabel}
    >
      <button
        ref={btnRef}
        type="button"
        className={"hoverSelectBtn" + (!value ? " isPlaceholder" : "")}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onButtonKeyDown}
        disabled={!!disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selectedDesc || undefined}
      >
        <span className="hoverSelectBtnLabel">{label}</span>
        <span className="hoverSelectChevron">▾</span>
      </button>

      {open && (
        <div className="hoverSelectMenuWrap">
          <div
            ref={menuRef}
            className="hoverSelectMenu"
            tabIndex={-1}
            onKeyDown={onMenuKeyDown}
          >
            <div className="hoverSelectMenuList" role="listbox">
              {options.map((o, i) => {
                const isSelected = o.name === value;
                const isActive = i === hoverIdx;
                return (
                  <button
                    key={o.name + String(i)}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={
                      "hsOption" +
                      (isSelected ? " selected" : "") +
                      (isActive ? " active" : "")
                    }
                    onMouseEnter={() => setHoverIdx(i)}
                    onFocus={() => setHoverIdx(i)}
                    onClick={() => chooseIdx(i)}
                  >
                    {o.name}
                  </button>
                );
              })}
            </div>

            <div className="hoverSelectMenuDesc">
              {activeDesc ? (
                <div>{activeDesc}</div>
              ) : (
                <div className="muted small">Hover an action to see its description.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// -----------------------------
// Pages
// -----------------------------
function LoginPage() {
  const nav = useNavigate();
  const [code, setCode] = useState("");
  const [email, setEmail] = useState(localStorage.getItem("expert_email") || "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onStart() {
    setErr(null);
    const c = code.trim();
    const e = email.trim();
    if (!c) return setErr("Please enter your access code.");
    if (!e) return setErr("Please enter your email.");
    setBusy(true);
    try {
      const res = await postJSON(`${API_BASE}/start`, { code: c, email: e });
      localStorage.setItem("token", String(res.token || ""));
      localStorage.setItem("pid", String(res.participant_id || ""));
      localStorage.setItem("expert_email", e);

      if (res?.assigned_chunk !== null && res?.assigned_chunk !== undefined) {
        localStorage.setItem("chunk_id", String(res.assigned_chunk));
        nav("/review");
      } else {
        localStorage.removeItem("chunk_id");
        nav("/chunks");
      }
    } catch (e2: any) {
      setErr(e2?.message || "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container">
      <div className="card">
        <h1 className="title">TOPA — Expert Review</h1>
        <p className="muted">
          Please enter your access code to help us review the cases where our automatic annotations have high uncertainty. <br /><br />
          These annotations were generated across multiple sessions with different patients using an action space of therapist behaviors organized into macro actions (high-level dialogue strategies/phases) and micro actions (utterance-level behaviors that realize each macro action). <br /><br />
          Thank you for your time and help with this review.
        </p>


        <div className="row">
          <label className="label">Access code</label>
          <input
            className="input"
            placeholder="EXPERT-XXXX"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onStart()}
            // Login page doesn't know the assigned chunk yet; server returns assigned_chunk.
            disabled={busy}
          />
        </div>

        <div className="row">
          <label className="label">Email</label>
          <input
            className="input"
            placeholder="name@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onStart()}
            disabled={busy}
          />
        </div>

        {err && <div className="alert danger">{err}</div>}

        <button className="btn primary" onClick={onStart} disabled={busy || !code || !email}>
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
  const storedChunkStr = localStorage.getItem("chunk_id");
  const storedChunk = storedChunkStr === null ? NaN : Number(storedChunkStr);
  const storedChunkFinite = Number.isFinite(storedChunk);
  const [chunkId, setChunkId] = useState<number>(storedChunkFinite ? storedChunk : 0);
  const [claimed, setClaimed] = useState<Set<number>>(new Set());
  const [mine, setMine] = useState<Set<number>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await postJSON(`${API_BASE}/chunks_status`, { token });
        const s = new Set<number>();
        for (const x of res?.claimed || []) s.add(Number(x));
        setClaimed(s);
        const m = new Set<number>();
        for (const x of res?.mine || []) m.add(Number(x));
        setMine(m);
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
      setErr(e?.data?.error || e?.message || "Unable to claim chunk");
    } finally {
      setBusy(false);
    }
  }

function onLogout() {
    localStorage.removeItem("token");
    localStorage.removeItem("pid");
    localStorage.removeItem("chunk_id");
    localStorage.removeItem("expert_email");
    nav("/");
  }

  return (
    <div className="container">
      <div className="card">
        <div className="topbar">
          <div>
            <h1 className="title">Select your chunk</h1>
            <p className="muted">
              Choose a chunk to work on. Chunk <strong>0</strong> contains the most uncertain items; chunk {NUM_CHUNKS - 1} is the least uncertain.
            </p>
          </div>
          <div className="topbarActions">
            {/* <div className="chip">ID: {pid || "—"}</div> */}
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
            {Array.from({ length: NUM_CHUNKS }, (_, i) => i).map((i) => (
              <option key={i} value={i} disabled={claimed.has(i) && !mine.has(i)}>
                Chunk {i} {mine.has(i) ? "(yours)" : claimed.has(i) ? "(claimed)" : ""}
              </option>
            ))}
          </select>
        </div>

        {err && <div className="alert danger">{err}</div>}

        <button className="btn primary" onClick={onContinue} disabled={busy}>
          {busy ? "Claiming…" : "Continue"}
        </button>
      </div>
    </div>
  );
}

function ReviewPage() {
  const nav = useNavigate();

  const token = localStorage.getItem("token") || "";
  const chunkId = Number(localStorage.getItem("chunk_id") || "0");

  const [macros, setMacros] = useState<ActionSpaceMacro[]>([]);

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
  const [microOtherDesc, setMicroOtherDesc] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const [expertConf, setExpertConf] = useState<string>(""); // "" or "1".."10"

  const [showTranscript, setShowTranscript] = useState(false);

  // Ensure chunk is claimed by this expert, and keep the lease alive.
  useEffect(() => {
    if (!token || !Number.isFinite(chunkId)) return;
    let alive = true;

    (async () => {
      try {
        await postJSON(`${API_BASE}/chunk_claim`, { token, chunk_id: chunkId });
      } catch (e: any) {
        if (!alive) return;
        setErr(e?.data?.error || e?.message || "This chunk is currently locked by another expert.");
      }
    })();

    const t = window.setInterval(() => {
      postJSON(`${API_BASE}/claim_heartbeat`, { token, chunk_id: chunkId }).catch(() => {});
    }, 60_000);

    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [token, chunkId]);


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

  // derive chunk subset (sorted by uncertainty / low confidence first)
  const chunkRows = useMemo(() => {
    if (!rows.length) return [];

    const stable = buildStableSortedRows(rows);
    const stableIdx = new Map(stable.map((r, i) => [makeKey(r), i] as const));
    const score = (v: any) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : -Infinity; // missing/NaN => most uncertain
    };

    const ranked = [...stable].sort((a, b) => {
      const da = score(a.confidence_score);
      const db = score(b.confidence_score);
      if (da !== db) return da - db;
      return (stableIdx.get(makeKey(a)) ?? 0) - (stableIdx.get(makeKey(b)) ?? 0);
    });

    const n = ranked.length;
    const start = Math.floor((n * chunkId) / NUM_CHUNKS);
    const end = Math.floor((n * (chunkId + 1)) / NUM_CHUNKS);
    return ranked.slice(start, Math.max(start, end));
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
    setMicroOtherDesc("");
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
    const md = macros.find((x) => x.name === macro);
    const base = md?.micro_actions || [];
    const items: Array<{ name: string; description: string }> = base
      .map((x) => (typeof x === "string" ? { name: x, description: "" } : { name: x?.name || "", description: x?.description || "" }))
      .filter((x) => !!x.name);

    const out: Array<{ name: string; description: string }> = [
      { name: "None", description: "No micro action / not applicable" },
      ...items,
      { name: "Other (custom)", description: "Provide your own label" },
    ];

    // keep unknown selection selectable
    if (micro && !out.some((o) => o.name === micro)) out.splice(1, 0, { name: micro, description: "" });

    // de-dup by name
    const seen = new Set<string>();
    return out.filter((o) => {
      if (seen.has(o.name)) return false;
      seen.add(o.name);
      return true;
    });
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
    localStorage.removeItem("expert_email");
    nav("/");
  }

  async function onSubmit(next: boolean) {
    if (!ensureAuth()) return;
    if (!cur) return;

    setErr(null);

    const chosenMacro = macro.trim();
    if (!chosenMacro) return setErr("Please select a macro action.");

    let chosenMicro: string | null = micro.trim();
    let chosenMicroCustom: string | null = null;
    let chosenMicroCustomDesc: string | null = null;

    if (chosenMicro === "Other (custom)") {
      const x = microOther.trim();
      const d = microOtherDesc.trim();
      if (!x) return setErr("Please enter your custom micro action");
      if (!d) return setErr("Please enter the custom micro description");
      chosenMicroCustom = x;
      chosenMicroCustomDesc = d;
    }

    const conf = expertConf ? Number(expertConf) : null;

    // We only advance to the next sample after the backend confirms the review
    // is stored in D1 (verified=true).
    const nextIdx = next ? Math.min(idx + 1, total - 1) : idx;

    setBusy(true);
    try {
      const payload = {
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
        expert_micro_custom_desc: chosenMicroCustomDesc,
        expert_confidence_1_10: conf,
        expert_note: note.trim() ? note.trim() : null,
        timestamp_utc: new Date().toISOString(),
        page_url: window.location.href,
        user_agent: navigator.userAgent,
        // Save *the position we will show next* so refresh/resume lands on the right item.
        current_pos: nextIdx,
      };

      const maxAttempts = 3;
      let res: any = null;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          res = await postJSON(`${API_BASE}/review_submit`, payload, undefined, { keepalive: true });
          break;
        } catch (e: any) {
          const status = Number(e?.status);
          // Don't retry auth/validation errors.
          if (Number.isFinite(status) && status < 500) throw e;
          if (attempt === maxAttempts - 1) throw e;
          // Exponential backoff: 400ms, 800ms, 1600ms
          await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt)));
        }
      }

      if (!res?.verified) {
        const e: any = new Error("Saved but could not be verified in the database. Please retry.");
        e.status = 500;
        throw e;
      }

      setReviewedKeys((prev) => {
        const s = new Set(prev);
        s.add(curKey);
        return s;
      });

      setIdx(nextIdx);
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

    const targetTurn = s.dialogue[targetIdx];
    const prevTurn = targetIdx > 0 ? s.dialogue[targetIdx - 1] : null;

    return {
      sessionTitle: s.session_metadata?.Title || `Session ${cur.session_idx}`,
      target: targetTurn ? { speaker: speakerPretty(targetTurn.speaker), text: targetTurn.text } : null,
      prev: prevTurn ? { speaker: speakerPretty(prevTurn.speaker), text: prevTurn.text } : null,
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
            {/* <div className="chip">ID: {pid || "—"}</div> */}
            <button className="btn" onClick={() => nav("/chunks")}>Change chunk</button>
            <button className="btn" onClick={onLogout}>Logout</button>
          </div>
        </div>

        {err && <div className="alert danger">{err}</div>}

        {!cur && (
          <div className="alert">
            Loading data... please wait.
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
                  {/* <div><span className="metaK">cluster</span> {cur.cluster_id ?? "—"}</div> */}
                </div>

                <div className="block">
                  <div className="label">Session summary</div>
                  <div className="textBox">{cur.session_summary || <span className="muted">—</span>}</div>
                </div>

                <div className="block">
                  <div className="label">Presenting conditions</div>
                  <div className="textBox">{cur.presenting_conditions || <span className="muted">—</span>}</div>
                </div>

                {transcript?.prev && (
                  <div className="block">
                    <div className="label">Previous utterance</div>
                    <div className="utterBox">
                      <div className="utterSpeaker">{transcript.prev.speaker}</div>
                      <div className="utterText">{transcript.prev.text}</div>
                    </div>
                  </div>
                )}

                {transcript?.target && (
                  <div className="block">
                    <div className="label">Utterance to review</div>
                    <div className="utterBox target">
                      <div className="utterSpeaker">{transcript.target.speaker}</div>
                      <div className="utterText">{transcript.target.text}</div>
                    </div>
                  </div>
                )}

                <div className="block">
                  <div className="label">Context</div>
                  <pre className="pre">{cur.context || ""}</pre>
                </div>
<div className="rowInline">
                  <button className="btn" onClick={() => setShowTranscript(true)} disabled={!transcript}>
                    Show the full session transcript
                  </button>
                  {!transcript && (
                    <span className="muted small">
                      Full transcript is not available.
                    </span>
                  )}
                </div>
              </div>

              <div className="panel">
                <h2 className="subtitle">Annotation Review</h2>

<div className="row">
                  <div className="autoAnn">
                    <div className="autoAnnTitle">Automatic annotation</div>
                    <div className="autoAnnGrid">
                      <div className="autoAnnLabel">Macro action:</div>
                      <div className="autoAnnValue">{cur?.selected_macro_action || "—"}</div>

                      <div className="autoAnnLabel">Micro action:</div>
                      <div className="autoAnnValue">{cur?.selected_micro_action || "—"}</div>

                      <div className="autoAnnLabel">Confidence score:</div>
                      <div className="autoAnnValue">
                        {cur?.confidence_score === null || cur?.confidence_score === undefined
                          ? "—"
                          : String(cur?.confidence_score)}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="row">
                  <label className="label">Macro action</label>
                  <HoverSelect
                    value={macro}
                    options={macros}
                    disabled={busy}
                    ariaLabel="Macro action"
                    onChange={(v) => {
                      setMacro(v);
                      setMicro("");
                      setMicroOther("");
                      setMicroOtherDesc("");
                    }}
                  />
                </div>

                <div className="row">
                  <label className="label">Micro action</label>
                  <HoverSelect
                    value={micro}
                    options={microOptions}
                    disabled={busy || !macro}
                    ariaLabel="Micro action"
                    onChange={(v) => {
                      setMicro(v);
                      setMicroOther("");
                      setMicroOtherDesc("");
                    }}
                  />
                </div>

                {micro === "Other (custom)" && (
                  <>
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
                    <div className="row">
                      <label className="label">Custom micro description</label>
                      <textarea
                        className="textarea"
                        placeholder="Describe what this custom micro action means…"
                        value={microOtherDesc}
                        onChange={(e) => setMicroOtherDesc(e.target.value)}
                        disabled={busy}
                      />
                      <div className="muted small">Required for custom micro actions.</div>
                    </div>
                  </>
                )}

                <div className="row">
                  <div className="label">Confidence (optional)</div>
                  <div className="help">1 (low) → 10 (high)</div>
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
                                    <button className="btn primary" onClick={() => onSubmit(true)} disabled={busy}>
                    {busy ? "Saving & verifying…" : idx >= total - 1 ? "Finish" : "Next"}
                  </button>
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
                    <div className="modalScroll">
                      {transcript.dialogue.map((d, i) => (
                        <div key={i} className={`turn ${d.isTarget ? "target" : ""}`}>
                          <div className="turnSpeaker">{d.speaker}</div>
                          <div className="turnText">{d.text}</div>
                        </div>
                      ))}
                    </div>
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