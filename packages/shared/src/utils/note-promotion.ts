// Smart note-promotion derivation. A note has a one-line `title` (NOT NULL) and
// an optional longer `body`. When a note is well-formed (a genuinely short
// one-liner title), promotion must be byte-identical to the legacy behavior —
// hence the ONLY-IF-LONG guard below: a title is touched ONLY when it is too
// long (or multi-line) to serve as a topic. When it IS shortened, the FULL
// original title is carried into the description so NOTHING is left out.

const ONE_LINER_MAX = 120; // title kept verbatim iff single-line AND length ≤ this (the guard)
const TOPIC_MAX = 100; // word-boundary truncation target for a derived topic

/**
 * Derive a SHORT proposal/task topic + a full-content description from a note.
 *
 * Title rule (first match wins):
 *  1. If `note.title` has NO newline AND its length ≤ {@link ONE_LINER_MAX} → the
 *     title VERBATIM (the only-if-long guard — well-formed notes are untouched).
 *  2. Otherwise the title is shortened to a topic:
 *     - the first non-empty trimmed line, if it fits ≤ {@link ONE_LINER_MAX};
 *     - else the first sentence (up to a `.!?` followed by whitespace/end), if
 *       it fits ≤ {@link ONE_LINER_MAX};
 *     - else a word-boundary truncation at or before {@link TOPIC_MAX}, with
 *       trailing whitespace/punctuation stripped and `"…"` appended.
 *
 * Description rule: the FULL content, so nothing is lost — when the title was
 * shortened the FULL original title is prepended, then the body. An empty
 * result becomes `undefined` (preserving the legacy "no description" behavior
 * for an empty-body, short-title note).
 *
 * Pure: no I/O, no clock.
 */
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

/** Shorten a too-long / multi-line title into a one-line topic. */
function deriveTopic(rawTitle: string): string {
  // (a) First non-empty line, if it fits.
  const firstLine = rawTitle.split("\n")[0]?.trim() ?? "";
  if (firstLine.length > 0 && firstLine.length <= ONE_LINER_MAX) {
    return firstLine;
  }

  // (b) First sentence (terminated by .!? + whitespace/end), if it fits.
  const sentenceMatch = rawTitle.match(/^.*?[.!?](?=\s|$)/);
  const sentence = sentenceMatch?.[0]?.trim() ?? "";
  if (sentence.length > 0 && sentence.length <= ONE_LINER_MAX) {
    return sentence;
  }

  // (c) Word-boundary truncation at or before TOPIC_MAX, then "…".
  const slice = rawTitle.slice(0, TOPIC_MAX);
  const lastSpace = slice.search(/\s\S*$/); // index of the last whitespace run
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return cut.replace(/[\s.,;:!?-]+$/, "") + "…";
}
