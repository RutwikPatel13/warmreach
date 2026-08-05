import type { Metadata } from "next";
import "./globals.css";
import AppShell from "./_components/AppShell";

export const metadata: Metadata = {
  title: "warmreach",
  description: "Cold outreach made warm — find the right people, personalize with Claude, draft in Gmail",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
