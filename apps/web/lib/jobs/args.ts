/** Launch arguments as the user types them: one line, shell-like quoting, per-locale placeholders. */
import { localeArgs } from "@shotwright/explorer";

/** Splits on whitespace; "double" or 'single' quotes keep spaces. No escapes, no variables. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  // Quoted runs, unquoted runs, or a stray quote taken literally.
  const pattern = /"([^"]*)"|'([^']*)'|([^\s"']+)|(["'])/g;
  let current = "";
  let lastEnd = -1;
  for (const match of line.matchAll(pattern)) {
    const piece = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
    // Adjacent pieces ("-a"'b' or -x"y z") belong to one argument.
    if (match.index === lastEnd) current += piece;
    else {
      if (lastEnd >= 0) out.push(current);
      current = piece;
    }
    lastEnd = match.index + match[0].length;
  }
  if (lastEnd >= 0) out.push(current);
  return out;
}

/** The region the explorer pairs with a language ("de" -> "DE"), from its own locale arguments. */
export function regionOf(language: string): string {
  const appleLocale = localeArgs({ language })[3] ?? "";
  return appleLocale.split("_")[1] ?? "US";
}

/** `{language}` and `{region}` replaced for one locale. */
export function expandArgs(args: readonly string[], language: string): string[] {
  const region = regionOf(language);
  return args.map((a) => a.replaceAll("{language}", language).replaceAll("{region}", region));
}
