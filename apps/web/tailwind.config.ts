import type { Config } from "tailwindcss";
import tailwindcssAnimate from "tailwindcss-animate";

// PABLO design tokens. Single dark theme by decision (see docs/ARCHITECTURE.md
// §10) — the brand *is* a dark terminal, there is no light variant to maintain.
export default {
  darkMode: ["class"],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "1.5rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      colors: {
        // Ground: near-black with a whisper of violet, not a pure #000 —
        // pure black kills the glassmorphism glow underneath it.
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        surface: {
          DEFAULT: "hsl(var(--surface))",
          raised: "hsl(var(--surface-raised))",
          border: "hsl(var(--surface-border))",
        },
        // Violet neon — the one accent. Used for interactive states,
        // focus rings, active nav, primary CTAs, glow. Not for decoration.
        pablo: {
          50: "#f4f1ff",
          100: "#ebe4ff",
          200: "#d9ccff",
          300: "#bfa6ff",
          400: "#a179ff",
          500: "#8b5cf6",
          600: "#7c3aed",
          700: "#6a28d6",
          800: "#5620ab",
          900: "#451c86",
          950: "#2b1058",
        },
        // Semantic — PnL and status only. Never reused as a decorative color.
        success: "hsl(var(--success))",
        danger: "hsl(var(--danger))",
        warning: "hsl(var(--warning))",
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
      },
      fontFamily: {
        display: ["var(--font-display)"],
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 4px)",
        sm: "calc(var(--radius) - 8px)",
      },
      boxShadow: {
        glow: "0 0 0 1px hsl(var(--pablo-glow) / 0.25), 0 0 24px -4px hsl(var(--pablo-glow) / 0.45)",
        "glow-lg": "0 0 0 1px hsl(var(--pablo-glow) / 0.3), 0 0 60px -8px hsl(var(--pablo-glow) / 0.55)",
      },
      backgroundImage: {
        "grid-fade":
          "linear-gradient(hsl(var(--surface-border) / 0.5) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--surface-border) / 0.5) 1px, transparent 1px)",
      },
      keyframes: {
        "pulse-glow": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.5" },
        },
        "fade-up": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "pulse-glow": "pulse-glow 2s ease-in-out infinite",
        "fade-up": "fade-up 0.4s ease-out",
      },
    },
  },
  plugins: [tailwindcssAnimate],
} satisfies Config;
