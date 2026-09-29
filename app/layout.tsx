import type { Metadata } from "next";
import "./globals.css";
import AppShell from "./_components/AppShell";

export const metadata: Metadata = {
  title: "warmreach",
  description: "Cold outreach made warm — find the right people, personalize with Claude, draft in Gmail",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // Browser extensions (Tsenta's overlay, password managers) stamp attributes
    // onto <html> before React loads. This silences that one element's attribute
    // mismatch only — it doesn't reach children, so real hydration bugs still show.
    <html lang="en" suppressHydrationWarning>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
