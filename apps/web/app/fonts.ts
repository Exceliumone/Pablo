import localFont from "next/font/local";

// Self-hosted, not next/font/google: the Google Fonts CSS API served this
// specific family/version with the exact same static file for weights
// 700/800/900 (verified by diffing the resolved URLs), so there was no
// real weight axis to lean on anyway — one 800-weight cut is what's
// actually distinct, used at whatever CSS font-weight the component asks
// for. Self-hosting also means the build never depends on live network
// access to fonts.gstatic.com, only on these files already being in the
// repo (see assets/fonts/).
export const displayFont = localFont({
  src: "../assets/fonts/big-shoulders-800.woff2",
  weight: "700 900",
  variable: "--font-display",
  display: "swap",
});

export const monoFont = localFont({
  src: "../assets/fonts/jetbrains-mono-500.woff2",
  weight: "400 600",
  variable: "--font-mono",
  display: "swap",
});
