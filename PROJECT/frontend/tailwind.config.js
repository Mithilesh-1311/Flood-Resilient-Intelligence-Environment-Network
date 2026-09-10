/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        base: { 900: "#080A0D", 800: "#0D1117", 700: "#11161C", 600: "#171D24", 500: "#1D242C" },
        line: { DEFAULT: "#1F262E", strong: "#2A333D", soft: "#171E25" },
        ink: { DEFAULT: "#E6EDF3", dim: "#9BA7B4", faint: "#6B7784", ghost: "#48525C" },
        accent: { DEFAULT: "#3FA7D6", dim: "#2B7EA1" },
        ok: { DEFAULT: "#3FB27F" },
        warn: { DEFAULT: "#D9A441" },
        crit: { DEFAULT: "#D9534F" },
        off: { DEFAULT: "#5A6472" }
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["JetBrains Mono", "IBM Plex Mono", "ui-monospace", "Consolas", "monospace"]
      },
      fontSize: {
        "2xs": ["10px", { lineHeight: "14px", letterSpacing: "0.08em" }],
        xs: ["11px", { lineHeight: "16px" }]
      },
      borderRadius: { DEFAULT: "2px", sm: "2px", md: "3px", lg: "4px" },
      transitionTimingFunction: { op: "cubic-bezier(0.22, 1, 0.36, 1)" }
    }
  },
  plugins: []
};
