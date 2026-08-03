import type { MergeRejectCategory } from "@pm/shared";

export interface CategorizeInput {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CategorizeResult {
  category: MergeRejectCategory;
  reason: string;
  failedFiles: string[];
}

function firstLineMatching(text: string, re: RegExp): string {
  const m = text.match(re);
  return m ? m[0].split("\n")[0].trim() : "";
}

// Words that mark a line as the "why did this fail" line for an otherwise
// unrecognized verify failure. Diagnostics/summaries live at the TAIL of a log
// (a build aborts, a test summary prints, a script echoes its error last), so
// `lastMeaningfulErrorLine` scans from the end for the last match.
const ERRISH_LINE =
  /\b(?:errored|error|fatal|abort(?:ing|ed)?|panic(?:ked)?|fail(?:ed|ure|ing)?|exception|traceback|unresolved|undefined reference|not found|no such file|cannot\b)/i;

/**
 * A line the log repeats verbatim at least this many times is boilerplate
 * chatter, not the distinguishing failure. Per-iteration runtime noise is
 * printed by construction on EVERY run — green ones included — so it carries
 * exactly zero information about why THIS verify failed, yet a tail scan is
 * guaranteed to return it whenever it is the last thing written.
 */
const CHATTER_MIN_REPEATS = 3;

/**
 * Best-effort one-line explanation for a verify failure that matched no known
 * toolchain signature. Without this, a real error (e.g. a codegen step aborting
 * with `layout drift ... aborting`) collapses to a bare "exit code N" and agents
 * misread a legitimate reject as an integrator fault. Operates on the FULL log
 * (not the capped excerpt), scanning from the tail so the actual abort/summary
 * line is found even after a multi-minute build. Length-capped so a pathological
 * single-line log can't blow the reason field.
 *
 * Repeated chatter is skipped (see CHATTER_MIN_REPEATS). The live bite: rynx's
 * headless audio teardown printed `failed to close audio stream: Invalid stream
 * pointer` 752 times on stderr (once per test-case sim), so EVERY game_one
 * reject reported that instead of its actual cause — and read as integrator
 * flakiness rather than as the red test suite it was. Chatter is only used as a
 * last resort, when the log holds nothing else err-ish.
 */
export function lastMeaningfulErrorLine(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return "";

  const repeats = new Map<string, number>();
  for (const l of lines) repeats.set(l, (repeats.get(l) ?? 0) + 1);

  let chatterFallback = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!ERRISH_LINE.test(lines[i])) continue;
    if ((repeats.get(lines[i]) ?? 0) >= CHATTER_MIN_REPEATS) {
      chatterFallback ||= lines[i];
      continue;
    }
    return lines[i].slice(0, 500);
  }
  return (chatterFallback || lines[lines.length - 1]).slice(0, 500);
}

/**
 * A TAIL slice of a verify log for the persisted `logExcerpt`. A head slice
 * (`.slice(0, cap)`) of a multi-minute build truncates the actual error — which
 * prints at the END — away entirely, leaving a stored excerpt of compiler banner
 * noise. Take the last `cap` chars instead, flagging the elided head so a reader
 * knows it's a tail.
 */
export function tailExcerpt(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `…[${text.length - cap} earlier chars omitted]\n${text.slice(-cap)}`;
}

/**
 * The persisted `logExcerpt` for a verify failure, budgeted ACROSS the two
 * streams rather than taken from their concatenation.
 *
 * Budgeting is the load-bearing part. `tailExcerpt(stdout + stderr, cap)` puts
 * one whole stream past the cap whenever the other is large, so a chatty stderr
 * evicts stdout ENTIRELY — and the diagnostic a reader needs is usually on
 * stdout (Catch2, MSBuild, and most test runners report there; stderr carries
 * runtime warnings). The live bite: 34 KB of `failed to close audio stream` on
 * stderr meant a 4 KB tail of the concatenation contained zero Catch2 output,
 * so the stored excerpt could not show which tests failed. Whichever stream a
 * given toolchain reports on, a share of the cap now survives for both.
 */
export function failureExcerpt(stdout: string, stderr: string, cap: number): string {
  const out = stdout ?? "";
  const err = stderr ?? "";
  if (!err) return tailExcerpt(out, cap);
  if (!out) return tailExcerpt(err, cap);
  // stdout gets the larger share: it is where diagnostics land far more often.
  const outCap = Math.floor(cap * 0.6);
  return (
    `--- stdout ---\n${tailExcerpt(out, outCap)}\n` +
    `--- stderr ---\n${tailExcerpt(err, cap - outCap)}`
  );
}

function parseRustcFiles(text: string): string[] {
  const out = new Set<string>();
  const re = /\s-->\s([^\s:]+):\d+:\d+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return [...out];
}

function parsePytestFailedFiles(text: string): string[] {
  const out = new Set<string>();
  const re = /_+ ([^\s]+\.py)::[^\s]+ _+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return [...out];
}

/**
 * A C/C++ toolchain compile-or-link failure: MSVC compiler (`error C2065`),
 * linker (`error LNK2019` / `fatal error LNK1236`), clang/gcc (`file:line:col:
 * error:`), or the MSBuild summary line (`N Error(s)` with N ≥ 1). Deliberately
 * matched BEFORE the lint heuristic so a real build error in a log that also
 * carries thousands of (non-fatal, `/WX-`) warnings is never mis-reported as a
 * lint failure. `N Error(s)` is pinned to its own MSBuild summary line and to
 * N ≥ 1 so a successful "0 Error(s)" build never matches.
 */
const CXX_BUILD_ERROR =
  /\bfatal error (?:LNK|C)\d+|\berror LNK\d+|\berror C\d{4}\b|^[^\n]*:\d+:\d+:\s+error:|^\s*[1-9]\d* Error\(s\)\s*$/m;

/**
 * Catch2 (v2/v3) console-reporter output with at least one REAL failure.
 *
 * The summary line is the authoritative signal, NOT a `FAILED:` assertion block:
 * a `[!shouldfail]` case prints a block of identical shape on a fully GREEN run,
 * and game_one's verify has three of them. Catch2 scores those as PASSES and
 * says so — `3 failed as expected` — which the negative lookahead keeps out. A
 * mixed summary (`| 1 failed | 2 failed as expected`) still matches on the real
 * term.
 */
const CATCH2_REAL_FAILURE = /^test cases:[^\n]*?\|\s*\d+ failed(?! as expected)/m;
const CATCH2_SUMMARY_LINE = /^test cases:[^\n]*$/gm;
/** `file.cpp(307): FAILED:` (MSVC) or `file.cpp:307: FAILED:` (POSIX). */
const CATCH2_FAILED_ASSERTION = /^(.+?)(?:\((\d+)\)|:(\d+)): FAILED:\s*\n\s*([^\n]*)/gm;
/** The 79-dash-delimited `----\n<test case name>\n----` header block. */
const CATCH2_CASE_HEADER = /^-{20,}\r?\n(.+?)\r?\n-{20,}$/gm;

/**
 * Reason + failed files for a Catch2 run, scoped to the LAST binary in the log
 * that actually failed.
 *
 * Scoping is required because one verify log carries several Catch2 binaries and
 * a green one still prints `FAILED:` blocks for its `[!shouldfail]` cases — an
 * unscoped sweep would name those as the failures. Each summary line closes its
 * own binary's segment, so the segment ending at the last real-failure summary
 * holds exactly that binary's output.
 */
function parseCatch2Failure(text: string): { reason: string; failedFiles: string[] } {
  const summaries = [...text.matchAll(CATCH2_SUMMARY_LINE)];
  let start = 0;
  let end = text.length;
  for (let i = 0; i < summaries.length; i++) {
    if (!CATCH2_REAL_FAILURE.test(summaries[i][0])) continue;
    start = i === 0 ? 0 : (summaries[i - 1].index ?? 0) + summaries[i - 1][0].length;
    end = summaries[i].index ?? text.length;
  }
  const segment = text.slice(start, end);
  const summaryLine = (summaries.find((s) => (s.index ?? -1) === end)?.[0] ?? "").trim();

  const headers = [...segment.matchAll(CATCH2_CASE_HEADER)];
  const failures = [...segment.matchAll(CATCH2_FAILED_ASSERTION)];
  const failedFiles = [...new Set(failures.map((f) => f[1].trim()))];

  const first = failures[0];
  if (!first) return { reason: summaryLine || "tests failed", failedFiles };

  // The case name is the nearest `----`-delimited header ABOVE the assertion.
  const caseName = headers
    .filter((h) => (h.index ?? 0) < (first.index ?? 0))
    .pop()?.[1]
    ?.trim();
  const where = `${first[1].trim()}:${first[2] ?? first[3]}`;
  const reason = [summaryLine, caseName && `"${caseName}"`, `${where}: ${first[4].trim()}`]
    .filter(Boolean)
    .join(" — ");
  return { reason: reason.slice(0, 500), failedFiles };
}

/** Best-effort failed-file extraction from C/C++/MSVC/linker error lines only. */
function parseCxxFailedFiles(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    if (!/\b(?:fatal )?error (?:LNK|C)\d+\b|:\d+:\d+:\s+error:/.test(line)) continue;
    // A real source ref (file.cpp(123,45): … / file.cpp:12:5: …) is the most useful.
    const src = line.match(/([^\s(]+\.(?:cpp|cc|cxx|c|hpp|hxx|h|inl))[\s(:]/i);
    if (src) {
      out.add(src[1]);
      continue;
    }
    // Linker errors carry no source; fall back to the failing MSBuild project.
    const proj = line.match(/\[([^\]\n]+\.vcxproj)\]/);
    if (proj) out.add(proj[1]);
  }
  return [...out];
}

export function categorize(input: CategorizeInput): CategorizeResult {
  const { exitCode, signal, stdout, stderr, timedOut } = input;
  const combined = `${stdout}\n${stderr}`;

  if (timedOut || exitCode === 124 || signal === "SIGTERM" || signal === "SIGKILL") {
    return { category: "verify_timeout", reason: "verify timed out", failedFiles: [] };
  }

  if (
    /error\[E\d{2,4}\]/.test(combined) ||
    (/error:/.test(combined) && /could not compile/.test(combined))
  ) {
    return {
      category: "build_failed",
      reason:
        firstLineMatching(combined, /(error\[E\d+\][^\n]*|error:[^\n]*could not compile[^\n]*)/) ||
        "build failed",
      failedFiles: parseRustcFiles(combined),
    };
  }

  // C/C++ / MSVC / linker / MSBuild compile-or-link failure — BEFORE the lint
  // check, so a hard error is never mis-reported as a warning. (Real-world bite:
  // an MSVC build with /WX- emits thousands of non-fatal warnings + one fatal
  // `LNK1236`; the old code fell through to the warning-matching lint branch and
  // surfaced a random `warning:` line as the reason.)
  if (CXX_BUILD_ERROR.test(combined)) {
    return {
      category: "build_failed",
      reason:
        firstLineMatching(
          combined,
          /[^\n]*\b(?:fatal error (?:LNK|C)\d+|error LNK\d+|error C\d{4})\b[^\n]*/,
        ) ||
        firstLineMatching(combined, /[^\n]*:\d+:\d+:\s+error:[^\n]*/) ||
        firstLineMatching(combined, /^\s*[1-9]\d* Error\(s\)\s*$/m) ||
        "build failed",
      failedFiles: parseCxxFailedFiles(combined),
    };
  }

  // Catch2 — the runner every rynx/game_one test binary uses. Before the
  // generic test arms because its `FAILED:` blocks match none of them, so
  // without this a red suite fell all the way through to `other` and reported
  // whatever err-ish line happened to be last in the log.
  if (CATCH2_REAL_FAILURE.test(combined)) {
    const { reason, failedFiles } = parseCatch2Failure(combined);
    return { category: "test_failed", reason: reason || "tests failed", failedFiles };
  }

  if (/FAILED \(failures=/.test(combined) || /=+ FAILURES =+/.test(combined)) {
    return {
      category: "test_failed",
      reason: firstLineMatching(combined, /FAILED[^\n]*|=+ FAILURES =+[^\n]*/) || "tests failed",
      failedFiles: parsePytestFailedFiles(combined),
    };
  }

  if (/test result: FAILED/.test(combined) || /^FAIL\s/m.test(combined)) {
    return {
      category: "test_failed",
      reason:
        firstLineMatching(combined, /test result: FAILED[^\n]*|^FAIL\s[^\n]*/m) || "tests failed",
      failedFiles: [],
    };
  }

  if (
    exitCode !== 0 &&
    (/^warning:/m.test(combined) ||
      /eslint/i.test(combined) ||
      /Prettier/.test(combined) ||
      /clippy::/.test(combined))
  ) {
    return {
      category: "lint_failed",
      reason:
        firstLineMatching(combined, /^warning:[^\n]*|eslint[^\n]*|clippy::[^\n]*/m) ||
        "lint failure",
      failedFiles: [],
    };
  }

  // Matched no known toolchain signature. Don't discard the log — surface the
  // most informative tail line so the reason is legible (bespoke verify scripts,
  // codegen steps, an unknown build tool aborting). Keep the "exit code N" prefix
  // so callers/tests that key on it still match.
  const detail = lastMeaningfulErrorLine(combined);
  return {
    category: "other",
    reason: detail
      ? `verify failed with exit code ${exitCode}: ${detail}`
      : `verify failed with exit code ${exitCode}`,
    failedFiles: [],
  };
}

// ─── Verify retry disposition (phase 7.2 Step 8, design §10) ──────────────────

export type VerifyDisposition = "transient" | "real";

/**
 * Classify a verify FAILURE as transient (retry the same member + same base) or
 * real (reject + suffix-invalidate). Layered on top of `categorize` (which stays
 * the reject-payload categorizer and is unchanged). NOT called on a clean exit 0.
 *
 * Ordering is load-bearing — `timedOut` MUST come first: a verify that hit OUR
 * timeout also carries `signal: SIGTERM` + `exitCode: null`, but it is REAL (the
 * verify was too slow), never transient.
 */
export function classifyVerifyFailure(r: {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnError?: string;
}): VerifyDisposition {
  if (r.timedOut) return "real"; // our own verify timeout = too slow = real
  if (r.spawnError) return "transient"; // child never ran
  if (r.exitCode === null && r.signal) return "transient"; // external signal-kill (not our timeout: timedOut handled above; not our abort: bailed before classification)
  if (r.exitCode !== 0) return "real"; // verify ran and failed on its own
  return "real"; // defensive (not called on exit 0)
}
