// Ambient declarations for non-TS assets imported for their side effects
// (e.g. `import "./globals.css"`). Keeps the strict TS type-checker happy;
// the actual CSS is handled by the Next.js bundler.
declare module "*.css";
