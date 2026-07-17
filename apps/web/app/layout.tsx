import type { Metadata } from "next";
import "./globals.css";
import { displayFont, monoFont } from "./fonts";
import { AppProviders } from "@/components/providers/app-providers";

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
    <html lang="en" className={`dark ${displayFont.variable} ${monoFont.variable}`}>
      <body className="min-h-screen antialiased">
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
