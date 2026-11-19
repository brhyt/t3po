export function t3poSearch(search: Record<string, unknown>): {
  project?: string | undefined;
  machine?: string | undefined;
  channel?: string | undefined;
  view?: "board" | undefined;
} {
  return {
    view: search.view === "board" ? "board" : undefined,
    project: typeof search.project === "string" ? search.project : undefined,
    machine: typeof search.machine === "string" ? search.machine : undefined,
    channel: typeof search.channel === "string" ? search.channel : undefined,
  };
}
