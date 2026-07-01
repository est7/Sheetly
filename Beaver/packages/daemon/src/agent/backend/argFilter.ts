export type BlockedArgMode = 'standalone' | 'withValue';

/**
 * Drop protocol-critical flags a profile's extra args must never override.
 * Beaver hardcodes the transport/output-format flags each provider's parser
 * depends on; a last-wins CLI would otherwise let `extraArgs` (e.g.
 * `--output-format text`, `--mode text`, `--listen tcp://…`) silently break the
 * stream parser and make a broken run look completed. Handles both
 * `--flag value` (drops the value too) and `--flag=value` forms. Mirrors the
 * Multica reference's custom-arg filtering.
 */
export function filterBlockedArgs(args: string[], blocked: Record<string, BlockedArgMode>): string[] {
  const out: string[] = [];
  let skipValue = false;
  for (const arg of args) {
    if (skipValue) {
      skipValue = false;
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const mode = blocked[flag];
    if (mode) {
      if (mode === 'withValue' && eq < 0) {
        skipValue = true; // the following arg is this flag's value — drop it too
      }
      continue;
    }
    out.push(arg);
  }
  return out;
}
