/**
 * Source-level seal for the phase-timing instrumentation (campaign 2026-08-03
 * §P2). Precedent: packages/server/tests/merge-phase-seal.test.ts.
 *
 * These invariants are not behaviours a runtime test can observe reliably — a
 * missing span looks exactly like a fast operation, and an awaited flush looks
 * exactly like a fast POST. They are properties of the SHAPE of the code, so
 * they are pinned where the shape lives.
 *
 * Every check runs against COMMENT-STRIPPED source. Otherwise the seal would be
 * a rule about prose: the comments that explain WHY `phases?.` is forbidden
 * necessarily contain `phases?.`, and a doc that says "never emit queue_wait"
 * would be the only thing standing between this file and green.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

/**
 * Remove `//` and block comments while PRESERVING string/template literals (a
 * `"https://…"` must not read as a line comment, and `phase: "forming"` must
 * still be findable). Newlines are kept so failures still point at a plausible
 * line. Regex literals are not lexed — no regex in this package contains a
 * comment or quote sequence that would confuse it.
 */
function stripComments(text: string): string {
  type State = "code" | "line" | "block" | "'" | '"' | "`";
  let out = "";
  let state: State = "code";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    if (state === "code") {
      if (c === "/" && d === "/") {
        state = "line";
        i += 2;
      } else if (c === "/" && d === "*") {
        state = "block";
        i += 2;
      } else {
        if (c === "'" || c === '"' || c === "`") state = c;
        out += c;
        i += 1;
      }
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && d === "/") {
        state = "code";
        i += 2;
      } else {
        if (c === "\n") out += c;
        i += 1;
      }
      continue;
    }
    // Inside a string literal: emit verbatim, honour escapes, close on the quote.
    out += c;
    if (c === "\\") {
      out += d ?? "";
      i += 2;
      continue;
    }
    if (c === state) state = "code";
    i += 1;
  }
  return out;
}

interface SourceFile {
  name: string;
  raw: string;
  code: string;
}

function sourceFiles(): SourceFile[] {
  return readdirSync(SRC)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => {
      const raw = readFileSync(path.join(SRC, f), "utf8");
      return { name: f, raw, code: stripComments(raw) };
    });
}

function fileNamed(name: string): SourceFile {
  const found = sourceFiles().find((f) => f.name === name);
  if (!found) throw new Error(`${name} not found in src`);
  return found;
}

describe("phase-timing seal — optional chaining on a span is a bug class", () => {
  it("`phases?.` appears nowhere in src", () => {
    // `phases?.time(spec, fn)` short-circuits the WHOLE call expression when
    // `phases` is nullish — so `fn` never runs and the rebase/push it was meant
    // to measure is silently deleted. The dependency is optional; the LOCAL is
    // coalesced once at function entry and is therefore non-nullable, which is
    // what makes this unwriteable rather than merely discouraged.
    const offenders = sourceFiles()
      .filter((f) => /\bphases\?\./.test(f.code))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it("every consumer of an optional `phases` dep coalesces it to a local", () => {
    // A vacuous pass would be worse than a failure: assert the coalesce EXISTS
    // wherever the optional dep is declared.
    const declarers = sourceFiles().filter((f) => /\n\s+phases\?: PhaseSpans;/.test(f.code));
    expect(declarers.map((f) => f.name).sort()).toEqual([
      "group-assembly.ts",
      "group-integration.ts",
      "group-land.ts",
    ]);
    for (const f of declarers) {
      expect(f.code, `${f.name} declares an optional phases dep`).toMatch(
        /deps\.phases \?\? NOOP_PHASE_SPANS/,
      );
    }
  });
});

describe("phase-timing seal — flush is never awaited", () => {
  it("no `await` immediately precedes a `.flush(` call", () => {
    const offenders = sourceFiles()
      .filter((f) => /await\s+[A-Za-z0-9_.]*\.flush\(/.test(f.code))
      .map((f) => f.name);
    // `flush()` returns void, so this cannot compile today — the seal is here so
    // a future signature change cannot quietly make the lane lock wait on PM.
    expect(offenders).toEqual([]);
  });

  it("the batch and group lanes both flush FIRST in their finally", () => {
    const batch = fileNamed("batch.ts").code;
    // The 2026-08-02 slot-leak seals are commented "FIRST in the finally, before
    // any await, so nothing downstream can skip it" — the phase flush earns the
    // same spot rather than sitting after `await releaseLock(...)` and thereby
    // inheriting a dependency on releaseLock never throwing.
    // "Flushes first" is asserted as "the finally body STARTS with the flush" —
    // nothing precedes it, not a statement that could throw and not even the
    // slot-leak reclaim (both are synchronous and total, so neither can starve
    // the other; being literally first is the cheap way to prove it).
    const finallyBodies = [...batch.matchAll(/\}\s*finally\s*\{([\s\S]{0,200})/g)].map((m) =>
      m[1].trimStart(),
    );
    const flushesFirst = finallyBodies.filter((body) => body.startsWith("phases.flush()"));
    // Exactly two: the batch lane's drain and the cross-repo group pass.
    expect(flushesFirst).toHaveLength(2);
    // ...and the flush appears in no other finally, i.e. nowhere late.
    expect(finallyBodies.filter((b) => b.includes("phases.flush()"))).toHaveLength(2);
  });
});

describe("phase-timing seal — the recorder itself", () => {
  it("phase-recorder.ts contains exactly ONE suspension point", () => {
    const code = fileNamed("phase-recorder.ts").code;
    // The one is the wrapped call inside `time`. Everything else — buffering,
    // normalization, the flush, the POST launch — is synchronous, and that is
    // what makes "telemetry never delays a merge" a property of the code rather
    // than a claim about it.
    expect((code.match(/\bawait\b/g) ?? []).length).toBe(1);
  });

  it("every postMergePhases CALL SITE is void-prefixed and carries a .catch(", () => {
    const callers = sourceFiles().filter((f) => /\.postMergePhases\(/.test(f.code));
    // pm-client.ts DECLARES the method (no leading dot) — only phase-recorder
    // CALLS it, and a second caller would have to come here and justify itself.
    expect(callers.map((f) => f.name)).toEqual(["phase-recorder.ts"]);
    for (const f of callers) {
      const idx = f.code.indexOf(".postMergePhases(");
      const window = f.code.slice(Math.max(0, idx - 200), idx + 600);
      expect(window).toMatch(/void\s+client\s*\.postMergePhases\(/);
      expect(window).toContain(".catch(");
    }
  });
});

describe("phase-timing seal — derived phases are never emitted", () => {
  it("no span names a PM-derived phase", () => {
    // PM derives `queue_wait` / `forming` from timestamps it already owns. A
    // daemon that also emitted them would double-count the wait — the ingest
    // enum 400s on them and `MergeObservedPhase` makes it a compile error, but
    // this pins the intent at a level a reader can check without running
    // anything. (`"forming"` unqualified is the merge-GROUP state and is
    // legitimately all over batch.ts — only the phase position is sealed.)
    for (const f of sourceFiles()) {
      expect(f.code, f.name).not.toContain("queue_wait");
      expect(f.code, f.name).not.toContain("MERGE_PHASES_DERIVED");
      expect(f.code, f.name).not.toMatch(/phase:\s*"forming"/);
    }
  });
});
