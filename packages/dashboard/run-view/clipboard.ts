// Putting text on the clipboard. `navigator.clipboard` needs a secure context and the browser's permission; where it is not
// there (or refuses) the old way, a selected text area and `execCommand("copy")`, still works from a click.

/** Copies `text`. Resolves to whether the browser accepted it. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* no clipboard API, or it was refused: try the old way */
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
