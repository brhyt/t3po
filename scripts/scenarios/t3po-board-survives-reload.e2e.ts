import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A project board stays selected after reconnecting to a bootstrapped server",
  WEB,
  async ({ t3, app, screen, browser }) => {
    await t3.project("Beta board");
    await t3.open();
    await screen.getByRole("link", "Beta board", { exact: true }).tap();
    await expect(screen.getByRole("heading", "Beta board", { exact: true })).toBeVisible();

    await browser.reload();
    await expect(screen.getByRole("button", "Add project").first()).toBeVisible();
    await app.screenshot("project-board-after-reload");
    await expect(screen.getByRole("heading", "Beta board", { exact: true })).toBeVisible();
  },
);
