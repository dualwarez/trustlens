/* TrustLens — Express backend.
   Holds the Clocked API key server-side; the browser never sees it.
   Every route wraps one Clocked endpoint (or the Pipeline endpoint for quick scan)
   and normalizes the response for the frontend. */

"use strict";

require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");

const {
  DECIDE_QUESTIONS,
  EXTRACT_FIELDS,
  FILL_SCHEMAS,
  FILL_INSTRUCTIONS,
  PII_ENTITIES,
  GUARD_INSTRUCTIONS,
  INSPECT_INSTRUCTIONS,
} = require("./schemas");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.CLOCKED_API_KEY;
const BASE_URL = "https://clocked.rezolve.ai/clocked";

if (!API_KEY) {
  console.error("Missing CLOCKED_API_KEY in .env — see .env.example");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ---------- credit accounting (X-Clocked-Credits on every response) ---------- */

const creditState = { used: 0, calls: 0, startedAt: new Date().toISOString() };

/* ---------- Clocked client ---------- */

async function clocked(endpoint, body, { timeoutMs = 90000 } = {}) {
  const call = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${BASE_URL}/${endpoint}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`, // never log this header
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let res = await call();
  if (res.status === 429) {
    // concurrency limit — brief backoff, then retry once with a fresh idempotency key
    await new Promise((r) => setTimeout(r, 1500));
    res = await call();
  }

  const credits = Number(res.headers.get("x-clocked-credits"));
  if (Number.isFinite(credits) && credits > 0) {
    creditState.used += credits;
    creditState.calls += 1;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data && (data.error || data.message || JSON.stringify(data)).slice(0, 300);
    throw Object.assign(new Error(`Clocked ${endpoint} failed (${res.status}): ${detail}`), {
      status: res.status === 429 ? 429 : 502,
    });
  }
  return data;
}

const wrap = (handler) => async (req, res) => {
  try {
    res.json(await handler(req.body || {}));
  } catch (err) {
    console.error(`[trustlens] ${req.path}:`, err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
};

/* ---------- 1 · Guard — POST /clocked/injection ---------- */

app.post("/api/guard", wrap(async ({ text }) => {
  const data = await clocked("injection", {
    text,
    source: "content",
    instructions: GUARD_INSTRUCTIONS,
    evidence: true,
  });
  const blocked = data.verdict && data.verdict !== "benign";
  const top = Object.entries(data.categories || {}).sort((a, b) => b[1] - a[1])[0];
  return {
    blocked,
    suspicious: !blocked && (data.injection ?? 0) >= 0.15,
    injectionScore: data.injection,
    verdict: data.verdict,
    category: data.category,
    severity: data.severity,
    evidence: data.evidence || [],
    detail: blocked
      ? `injection ${(data.injection * 100).toFixed(1)}% · ${data.category} · severity ${data.severity}`
      : `benign (${(((data.categories || {}).benign ?? (1 - (data.injection ?? 0))) * 100).toFixed(0)}% benign)`,
    raw: top ? undefined : undefined,
  };
}));

/* ---------- 2 · Protect — POST /clocked/pii ---------- */

function piiHighlightHtml(maskedText) {
  const escaped = String(maskedText)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // placeholders look like <PERSON>, <EMAIL_1>, … — highlight them
  return escaped.replace(/&lt;([A-Z_][A-Z_0-9]*)(_\d+)?&gt;/g,
    (m) => `<mark class="pii">${m}</mark>`);
}

app.post("/api/protect", wrap(async ({ text }) => {
  const data = await clocked("pii", {
    text,
    entities: PII_ENTITIES,
    anonymize: "replace",
    threshold: 0.5,
  });
  const findings = (data.entities || []).map((e) => ({
    type: e.type, value: e.value, start: e.start, end: e.end, confidence: e.confidence,
  }));
  return {
    findings,
    counts: data.counts || {},
    maskedText: data.anonymized_text ?? text,
    maskedHtml: piiHighlightHtml(data.anonymized_text ?? text),
    detail: `${findings.length} PII item(s) masked`,
  };
}));

/* ---------- 3 · Inspect — POST /clocked/script ---------- */

app.post("/api/inspect", wrap(async ({ text }) => {
  const data = await clocked("script", {
    script: text,
    instructions: INSPECT_INSTRUCTIONS,
    evidence: true,
  });
  const dangerous = !!data.verdict && !String(data.verdict).toLowerCase().startsWith("benign");
  return {
    dangerous,
    verdict: data.verdict,
    maliciousScore: data.malicious,
    suspiciousScore: data.suspicious,
    category: data.category,
    severity: data.severity,
    evidence: data.evidence || [],
    detail: dangerous
      ? `${data.verdict} · ${(data.malicious * 100).toFixed(1)}% · ${data.category}`
      : `no dangerous commands (${((1 - (data.suspicious ?? 0)) * 100).toFixed(0)}% benign)`,
  };
}));

/* ---------- 4 · Decide — POST /clocked/decide ---------- */

app.post("/api/decide", wrap(async ({ text }) => {
  const data = await clocked("decide", { state: text, questions: DECIDE_QUESTIONS });
  const a = data.answers || {};
  const docType = a.doc_type?.choice || "general_correspondence";
  const priorityIndex = Math.round(a.priority?.score ?? 0);
  const priority = (a.priority?.legend || {})[String(priorityIndex)] || "Normal";
  return {
    docType,
    docTypeProbabilities: a.doc_type?.probabilities || {},
    confidence: a.doc_type?.confidence ?? 0,
    priority,
    priorityIndex,
    priorityProbabilities: a.priority?.probabilities || {},
    detail: `${docType} · ${priority} priority`,
  };
}));

/* ---------- 5 · Extract — POST /clocked/extract ---------- */

function flattenExtract(fieldsMap) {
  const out = [];
  for (const [name, f] of Object.entries(fieldsMap || {})) {
    if (f == null) continue;
    const item = Array.isArray(f.items) && f.items.length ? f.items[0] : null;
    out.push({
      name,
      value: Array.isArray(f.value) ? f.value.join(" | ") : (f.value ?? null),
      start: Number.isFinite(f.start) ? f.start : (item && Number.isFinite(item.start) ? item.start : null),
      end: Number.isFinite(f.end) ? f.end : (item && Number.isFinite(item.end) ? item.end : null),
      confidence: f.confidence ?? null,
      list: Array.isArray(f.value),
    });
  }
  return out;
}

app.post("/api/extract", wrap(async ({ text, docType }) => {
  const fields = EXTRACT_FIELDS[docType] || EXTRACT_FIELDS.general_correspondence;
  const data = await clocked("extract", { text, fields });
  return { fields: flattenExtract(data.fields), docType };
}));

/* ---------- 6 · Fill — POST /clocked/fill ---------- */

app.post("/api/fill", wrap(async ({ text, docType }) => {
  const fields = FILL_SCHEMAS[docType] || FILL_SCHEMAS.general_correspondence;
  const data = await clocked("fill", { text, fields, instructions: FILL_INSTRUCTIONS });
  const record = {};
  for (const [name, f] of Object.entries(data.fields || {})) {
    if (!f || f.value === null || f.value === undefined) continue;
    record[name] = f.value;
  }
  return { record, docType, model: data.model };
}));

/* ---------- 7 · Verify — POST /clocked/grounding ---------- */

function buildClaims(record) {
  const claims = [];
  const meta = [];
  for (const [field, value] of Object.entries(record || {})) {
    if (value === null || value === undefined || value === "") continue;
    const valueText = Array.isArray(value) ? value.join("; ") : String(value);
    claims.push(`${field.replace(/_/g, " ")} is ${valueText}`);
    meta.push({ field, value: valueText });
  }
  return { claims: claims.slice(0, 30), meta: meta.slice(0, 30) };
}

app.post("/api/verify", wrap(async ({ record, source }) => {
  const { claims, meta } = buildClaims(record);
  if (!claims.length) return { checks: [], groundedScore: null };
  const data = await clocked("grounding", {
    documents: [{ id: "source", text: source }],
    answer: claims.map((c, i) => `${i + 1}. ${c}`).join("\n"),
    claims,
    instructions:
      "Each claim states one field of a structured record built from the source text. " +
      "Judge each claim only against the supplied source document.",
    threshold: 0.5,
    evidence: "flagged",
  });
  const checks = (data.claims || []).map((c, i) => ({
    field: meta[i]?.field ?? `claim ${i + 1}`,
    value: meta[i]?.value ?? c.claim,
    verdict: c.verdict === "supported" ? "grounded" : "ungrounded",
    reason:
      c.verdict === "supported"
        ? (c.evidence ? `supported by source (${Math.round((c.probabilities?.supported ?? 1) * 100)}%)` : `supported (${Math.round((c.probabilities?.supported ?? 1) * 100)}%)`)
        : c.verdict === "not_stated"
          ? "not stated in the source"
          : `contradicted by the source (${Math.round((c.probabilities?.contradicted ?? 0) * 100)}%)`,
  }));
  return { checks, groundedScore: data.grounded, overallVerdict: data.verdict };
}));

/* ---------- 8 · Ask — POST /clocked/rerank + /clocked/grounding ---------- */

function splitPassages(text) {
  const paragraphs = String(text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const passages = [];
  for (const p of paragraphs) {
    if (p.length <= 700) { passages.push(p); continue; }
    const sentences = p.match(/[^.!?\n]+[.!?]?/g) || [p];
    let buf = "";
    for (const s of sentences) {
      if ((buf + s).length > 500 && buf) { passages.push(buf.trim()); buf = s; }
      else buf += s;
    }
    if (buf.trim()) passages.push(buf.trim());
  }
  return passages.slice(0, 60);
}

app.post("/api/ask", wrap(async ({ text, question }) => {
  const passages = splitPassages(text);
  const rr = await clocked("rerank", {
    query: question,
    documents: passages.map((t, i) => ({ id: `p${i}`, text: t })),
    top_n: 4,
  });
  const results = rr.results || [];
  const used = results.filter((r) => r.action === "use");
  const chosen = (used.length ? used : results.slice(0, 2)).slice(0, 3);
  const answer = chosen.map((r) => passages[r.index]).join(" ");
  if (!answer) return { answer: null, verdict: null, passages: [] };

  const gr = await clocked("grounding", {
    documents: [{ id: "source", text }],
    answer,
    question,
    instructions: "The answer is assembled from passages of the source document. Verify it answers the question using only the source.",
    threshold: 0.5,
    evidence: "none",
  });
  return {
    answer,
    verdict: (gr.grounded ?? 0) >= 0.5 ? "grounded" : "ungrounded",
    groundedScore: gr.grounded,
    answersQuestion: gr.answers_question,
    passages: chosen.map((r) => ({
      text: passages[r.index],
      score: r.relevance_score,
      action: r.action,
    })),
  };
}));

/* ---------- 9 · Compare — POST /clocked/compare ---------- */

app.post("/api/compare", wrap(async ({ textA, textB }) => {
  const data = await clocked("compare", {
    documents: [
      { id: "document-a", text: textA },
      { id: "document-b", text: textB },
    ],
    instructions:
      "Compare these business documents. Surface every conflict in amounts, dates, " +
      "identifiers, obligations, and named entities.",
    evidence: "all",
  });
  const pair = (data.pairs || [])[0] || {};
  const kindLabel = (c) => {
    if (Array.isArray(c.kinds)) return c.kinds.join(", ");
    if (c.kinds && typeof c.kinds === "object") {
      return Object.entries(c.kinds)
        .sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0))
        .filter(([, v]) => Number(v) > 0.2)
        .slice(0, 2)
        .map(([k]) => k.replace(/_/g, " "))
        .join(", ") || c.kind || "conflict";
    }
    return c.kind || "conflict";
  };
  const differences = [];
  for (const c of (pair.conflicts || []).slice(0, 8)) {
    differences.push({
      kind: "mismatch",
      field: kindLabel(c),
      detail: `"${c.a?.quote ?? "?"}" vs "${c.b?.quote ?? "?"}"`,
    });
  }
  for (const d of (pair.duplicates || []).slice(0, 5)) {
    differences.push({
      kind: "match",
      field: "shared content",
      detail: `"${d.a?.quote ?? "?"}" appears in both documents`,
    });
  }
  return {
    verdict: data.verdict,
    relation: pair.relation,
    relatedScore: pair.related,
    differences,
  };
}));

/* ---------- 10 · Quick scan — POST /clocked/pipeline (one call, one bill) ---------- */

app.post("/api/quickscan", wrap(async ({ text }) => {
  const data = await clocked("pipeline", {
    text,
    steps: [
      { injection: { source: "content", instructions: GUARD_INSTRUCTIONS }, stop: true, name: "guard" },
      { pii: { entities: PII_ENTITIES, anonymize: "replace" }, name: "protect" },
      { script: { instructions: INSPECT_INSTRUCTIONS }, name: "inspect" },
    ],
    on_error: "continue",
  });
  const steps = (data.steps || []).map((s) => ({
    name: s.name || s.endpoint,
    endpoint: s.endpoint,
    status: s.status,
    ms: s.ms,
    skipped: s.status === null || !!s.skipped,
    summary: s.result
      ? s.endpoint === "injection"
        ? `${s.result.verdict} (${(s.result.injection * 100).toFixed(1)}%)`
        : s.endpoint === "pii"
          ? `${Object.values(s.result.counts || {}).reduce((a, b) => a + b, 0)} PII item(s) masked`
          : s.endpoint === "script"
            ? `${s.result.verdict}`
            : "done"
      : s.error || "skipped",
  }));
  return { steps, stopped: data.stopped, totalMs: data.timing?.total_ms };
}));

/* ---------- credits (session accounting from response headers) ---------- */

app.get("/api/credits", (req, res) => {
  res.json({
    used: creditState.used,
    calls: creditState.calls,
    allowance: 20000,
    remaining: Math.max(0, 20000 - creditState.used),
    startedAt: creditState.startedAt,
  });
});

/* ---------- boot ---------- */

app.listen(PORT, () => {
  console.log(`[trustlens] listening on http://localhost:${PORT}`);
});
