/**
 * T3PO tools a lead or channel chat calls for its own bookkeeping: its notes, its
 * schedules and its project's drawn icon. They touch no files and run no code, so
 * they run without an approval prompt even in a supervised or read-only chat.
 * Routing a job (t3_work_route) is not here: it starts agents and keeps its prompt.
 */
export const T3PO_SELF_APPROVED_TOOLS = [
  "t3_notes_update",
  "t3_work_schedule",
  "t3_project_icon_set",
] as const;
