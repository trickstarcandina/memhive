/** Polls `cond` until it returns a truthy value (returned) or `timeout` ms pass (throws). Use instead of fixed sleeps. */
export async function waitFor<T>(cond: () => T | Promise<T>, opts: { timeout?: number; interval?: number; what?: string } = {}): Promise<NonNullable<T>> {
  const deadline = Date.now() + (opts.timeout ?? 5000);
  for (;;) {
    const v = await cond();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${opts.timeout ?? 5000} ms${opts.what ? `: ${opts.what}` : ''}`);
    await new Promise((r) => setTimeout(r, opts.interval ?? 20));
  }
}
