// The only glob the config needs: `*` (any run of characters) and `?` (one character). Used for the label fallback
// (`desenhar:*`) and for the `allowedModels` cap (`composer-*`).

export function globToRegExp(glob: string): RegExp {
  const body = [...glob].map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("");
  return new RegExp(`^${body}$`, "s");
}

export const globMatches = (glob: string, text: string): boolean => globToRegExp(glob).test(text);

/** How specific a glob is: the number of characters that are not wildcards. */
export const literalLength = (glob: string): number => glob.replace(/[*?]/g, "").length;
