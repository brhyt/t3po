import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { ProjectId } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { ExternalActionSettings } from "./ExternalActionSettings";

it("disables the existing connection using its version without losing the account binding", async () => {
  const projectId = ProjectId.make("project");
  const save = vi.fn(async () => {});
  await using screen = await render(
    <ExternalActionSettings
      projectId={projectId}
      disabled={false}
      save={save}
      bindings={[
        {
          projectId,
          version: 2,
          host: "github.com",
          accountId: "account-1",
          repository: "owner/repo",
          enabled: true,
        },
      ]}
    />,
  );
  await userEvent.click(screen.getByText("External actions", { exact: true }));
  await expect.element(screen.getByRole("checkbox", { name: "Enable proposals" })).toBeChecked();
  await userEvent.click(screen.getByRole("checkbox", { name: "Enable proposals" }));
  await userEvent.click(screen.getByRole("button", { name: "Save connection" }));
  expect(save).toHaveBeenCalledWith({
    type: "save_external_binding",
    projectId,
    expectedVersion: 2,
    host: "github.com",
    accountId: "account-1",
    repository: "owner/repo",
    enabled: false,
  });
});
