import type { Metadata } from "next";
import { SessionView } from "./session-view.tsx";

export const metadata: Metadata = {
  title: "Session · Shotwright",
};

export default function SessionPage() {
  return <SessionView />;
}
