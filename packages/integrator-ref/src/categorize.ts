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

export function categorize(input: CategorizeInput): CategorizeResult {
  const { exitCode, signal, stdout, stderr, timedOut } = input;
  const combined = `${stdout}\n${stderr}`;

  if (timedOut || exitCode === 124 || signal === "SIGTERM" || signal === "SIGKILL") {
    return { category: "verify_timeout", reason: "verify timed out", failedFiles: [] };
  }

  if (/error\[E\d{2,4}\]/.test(combined) || (/error:/.test(combined) && /could not compile/.test(combined))) {
    return {
      category: "build_failed",
      reason: firstLineMatching(combined, /(error\[E\d+\][^\n]*|error:[^\n]*could not compile[^\n]*)/) || "build failed",
      failedFiles: parseRustcFiles(combined),
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
      reason: firstLineMatching(combined, /test result: FAILED[^\n]*|^FAIL\s[^\n]*/m) || "tests failed",
      failedFiles: [],
    };
  }

  if (exitCode !== 0 && (/^warning:/m.test(combined) || /eslint/i.test(combined) || /Prettier/.test(combined) || /clippy::/.test(combined))) {
    return {
      category: "lint_failed",
      reason: firstLineMatching(combined, /^warning:[^\n]*|eslint[^\n]*|clippy::[^\n]*/m) || "lint failure",
      failedFiles: [],
    };
  }

  return { category: "other", reason: `verify failed with exit code ${exitCode}`, failedFiles: [] };
}
