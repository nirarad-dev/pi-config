import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";
import { I18nProvider } from "@/hooks/useI18n";

export default function ChatPage() {
  return <Suspense><I18nProvider><AppShell /></I18nProvider></Suspense>;
}
