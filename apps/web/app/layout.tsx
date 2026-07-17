import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PABLO",
  description: "Sniper terminal for the $PABLO ecosystem.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
