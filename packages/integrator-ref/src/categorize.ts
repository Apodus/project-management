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

  return { category: "other", reason: `verify failed with exit code ${exitCode}`, failedFiles: [] };
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
