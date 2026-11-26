import { createFileRoute } from "@tanstack/react-router";
import { ToolsSettingsPanel } from "../components/t3po/ToolsSettings";

export const Route = createFileRoute("/_chat/settings/tools")({
  component: ToolsSettingsPanel,
});
