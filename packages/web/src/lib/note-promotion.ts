// Web mirror of `deriveNotePromotion` from @pm/shared (the web package does NOT
// depend on @pm/shared — it mirrors shared logic locally, as with
// cacheConfigWarnings / the escalation enums). Keep in lockstep with
// packages/shared/src/utils/note-promotion.ts.
//
// A note has a one-line `title` (NOT NULL) and an optional longer `body`. When a
// note is well-formed (a genuinely short one-liner title) promotion is
// byte-identical to the legacy behavior — the ONLY-IF-LONG guard below touches a
// title ONLY when it is too long (or multi-line) to serve as a topic. When it IS
// shortened, the FULL original title is carried into the description so NOTHING
// is lost.

const ONE_LINER_MAX = 120; // title kept verbatim iff single-line AND length ≤ this (the guard)
const TOPIC_MAX = 100; // word-boundary truncation target for a derived topic

export function deriveNotePromotion(note: { title: string; body: string | null }): {
  title: string;
  description: string | undefined;
} {
  const { title: rawTitle, body } = note;

  const titleWasShortened = rawTitle.includes("\n") || rawTitle.length > ONE_LINER_MAX;
  const title = titleWasShortened ? deriveTopic(rawTitle) : rawTitle;

  const description =
    [titleWasShortened ? rawTitle : null, body].filter(Boolean).join("\n\n") || undefined;

  return { title, description };
}

function deriveTopic(rawTitle: string): string {
  const firstLine = rawTitle.split("\n")[0]?.trim() ?? "";
  if (firstLine.length > 0 && firstLine.length <= ONE_LINER_MAX) {
    return firstLine;
  }

  const sentenceMatch = rawTitle.match(/^.*?[.!?](?=\s|$)/);
  const sentence = sentenceMatch?.[0]?.trim() ?? "";
  if (sentence.length > 0 && sentence.length <= ONE_LINER_MAX) {
    return sentence;
  }

  const slice = rawTitle.slice(0, TOPIC_MAX);
  const lastSpace = slice.search(/\s\S*$/);
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return cut.replace(/[\s.,;:!?-]+$/, "") + "…";
}
