import { createFileRoute } from "@tanstack/react-router";
import { PrivacyPage } from "../components/privacy/PrivacyPage";
export const Route = createFileRoute("/_chat/privacy")({ component: PrivacyPage });
