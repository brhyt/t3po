import type { OrchestrationV2ConversationMessage, ProjectId, ThreadId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ApplicationEvents from "../persistence/OrchestrationEventStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Service from "./Service.ts";
import * as Store from "./Store.ts";

/** User messages across a project's lead and channel conversations before an unnamed lead names itself. */
const LEAD_NAMING_USER_TURNS = 3;

const NAMING_INSTRUCTIONS = `This title is the name of the project's lead agent, not a single task. It appears on every conversation the lead runs for this project.
Return a short role name of two to four words for who handles this work, such as "Brega Growth Lead" or "Studio Ops Lead". Use the project's subject, not the latest request.`;

const isLeadConversation = (threadId: string) =>
  threadId.startsWith("t3po-lead:") || threadId.startsWith("t3po-channel:");

/** A generated title, cleaned into a lead name, or undefined when it cannot serve as one. */
export const leadNameFromTitle = (title: string): string | undefined => {
  const name = title
    .trim()
    .replace(/^["'“”‘’`]+|["'“”‘’`.]+$/g, "")
    .trim()
    .slice(0, 80)
    .trim();
  return name === "" || name === "New thread" ? undefined : name;
};

/** Whether a lead with `userTurns` user messages is due for a naming attempt. */
export const leadNamingDue = (userTurns: number, failedAtTurns: number | undefined) =>
  userTurns >= LEAD_NAMING_USER_TURNS &&
  (failedAtTurns === undefined || userTurns >= failedAtTurns + LEAD_NAMING_USER_TURNS);

/**
 * Names leads saved without a name. After each finished assistant message in a lead or channel
 * conversation, a lead still on its placeholder names itself from its conversations once they hold
 * enough user turns. A name the user saves meanwhile wins.
 */
export const run = Effect.gen(function* () {
  const events = yield* ApplicationEvents.OrchestrationEventStore;
  const store = yield* Store.Store;
  const service = yield* Service.Service;
  const threads = yield* Threads.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const failedAtTurns = new Map<ProjectId, number>();
  const inFlight = new Set<ProjectId>();

  const currentLead = (projectId: ProjectId) =>
    store
      .list({ projectId, metadataOnly: true })
      .pipe(Effect.map((records) => records.leads.find((lead) => lead.projectId === projectId)));

  const nameLead = Effect.fn("T3poLeadNaming.nameLead")(function* (threadId: ThreadId) {
    const shell = yield* threads.getThreadShell(threadId);
    if (!shell || inFlight.has(shell.projectId)) return;
    const projectId = shell.projectId;
    const lead = yield* currentLead(projectId);
    if (!lead?.autoName) return;
    const records = yield* store.list({ projectId, metadataOnly: true });
    const conversationIds = [
      lead.threadId,
      ...records.channels
        .filter((channel) => channel.projectId === projectId && !channel.archived)
        .map((channel) => `t3po-channel:${channel.id}` as ThreadId),
    ];
    const messages: Array<OrchestrationV2ConversationMessage> = [];
    for (const id of conversationIds) {
      if (!(yield* threads.getThreadShell(id))) continue;
      const projection = yield* threads.getThreadRecords(id, ["messages"], {
        messageRoles: ["user", "assistant"],
      });
      messages.push(...projection.messages.filter((message) => !message.streaming));
    }
    const userTurns = messages.filter((message) => message.role === "user").length;
    if (!leadNamingDue(userTurns, failedAtTurns.get(projectId))) return;
    const project = yield* projects.getById(projectId);
    if (Option.isNone(project)) return;
    inFlight.add(projectId);
    yield* Effect.gen(function* () {
      const context = formatThreadTitleContext(
        messages.toSorted((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
      );
      const settings = resolveProjectSettings(
        yield* serverSettings.getSettings,
        projectId,
      ).settings;
      const result = yield* textGeneration.generateThreadTitle({
        cwd: project.value.workspaceRoot,
        message: context.message,
        projectTitle: project.value.title,
        instructions: NAMING_INSTRUCTIONS,
        modelSelection: settings.textGenerationModelSelection,
        projectId,
      });
      const name = leadNameFromTitle(result.title);
      if (name === undefined) {
        failedAtTurns.set(projectId, userTurns);
        return;
      }
      // The user may have named the lead while the name was generating.
      const latest = yield* currentLead(projectId);
      if (!latest?.autoName) return;
      yield* service.mutate({ type: "save_lead", projectId, name, brief: latest.brief });
      failedAtTurns.delete(projectId);
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.sync(() => failedAtTurns.set(projectId, userTurns)).pipe(
              Effect.andThen(Effect.logWarning("T3PO lead naming failed", { projectId, cause })),
            ),
      ),
      Effect.ensuring(Effect.sync(() => inFlight.delete(projectId))),
    );
  });

  const afterSequence = yield* events.latestApplicationSequence;
  yield* events.streamApplicationEvents({ afterSequence }).pipe(
    Stream.filter(
      (stored) =>
        "event" in stored &&
        isLeadConversation(stored.event.threadId) &&
        ((stored.event.type === "turn-item.updated" &&
          stored.event.payload.type === "assistant_message" &&
          !stored.event.payload.streaming) ||
          (stored.event.type === "message.updated" &&
            stored.event.payload.role === "assistant" &&
            !stored.event.payload.streaming)),
    ),
    Stream.runForEach((stored) =>
      "event" in stored
        ? nameLead(stored.event.threadId).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("T3PO lead naming check failed", { cause }),
            ),
          )
        : Effect.void,
    ),
  );
});
