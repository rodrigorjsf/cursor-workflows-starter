// How a word is written in a POSIX shell command line. Pure.

/** `word` as one shell word: as it is when it holds only characters the shell leaves alone, otherwise in single quotes. */
export function shellQuote(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}
