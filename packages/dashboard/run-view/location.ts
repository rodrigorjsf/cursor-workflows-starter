// The address of the Run view page, `/runs/<runId>`. The Board and the Runs table, which are another page (`app/`), write the link
// with `runHref` in `app/format.ts`; a test pins that the two agree.

/** The run id the address names: the second segment, percent-decoded. Empty when there is none or it is not valid percent-encoding. */
export function runIdOf(pathname: string): string {
  const segment = pathname.split("/")[2] ?? "";
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}
