import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "warmreach",
  description: "Cold outreach made warm — find the right people, personalize with Claude, draft in Gmail",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
