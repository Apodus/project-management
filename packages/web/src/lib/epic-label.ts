export interface EpicLabelParts {
  tag: string | null;
  topic: string;
}

// Split an epic name into a structural metadata tag ([P6-zprepass] C2 …) and the
// human topic. Pure + total: always returns a non-empty topic; degrades to
// {tag:null, topic:name} on non-conforming names. Never splits an in-word hyphen.
const PREFIX_RE = /^((?:\[[^\]]*\]|[A-Z]{1,3}\d{1,3}|P\d+)(?:\s+|(?=[:—–])|$))+/;
const SEP_RE = /^\s*(?:[—–:]|-\s)\s*/; // strip a leading separator from the remainder

export function parseEpicLabel(name: string): EpicLabelParts {
  const m = name.match(PREFIX_RE);
  if (!m || m[0].trim() === "") return { tag: null, topic: name };
  const tag = m[0].trim();
  const rest = name.slice(m[0].length).replace(SEP_RE, "");
  if (rest.trim() === "") return { tag: null, topic: name }; // tag-only → show whole name
  return { tag, topic: rest.trim() };
}
