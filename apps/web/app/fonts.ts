import { Big_Shoulders, JetBrains_Mono } from "next/font/google";

// Display: condensed, heavy, stencil-adjacent — carries the same weight as
// the PABLO wordmark lettering. Body stays a plain system sans (see
// globals.css --font-sans) so the display face is the one thing that reads
// as "designed" rather than defaulting to Inter everywhere.
export const displayFont = Big_Shoulders({
  subsets: ["latin"],
  weight: ["700", "800", "900"],
  variable: "--font-display",
});

// Tabular numerals for a trading terminal aren't optional — prices, PnL,
// and percentages need a real monospace, not a system fallback.
export const monoFont = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});
