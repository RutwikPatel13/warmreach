/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep the Node-only Google libraries out of the bundler; they're used
  // server-side in the API routes and rely on Node built-ins.
  serverExternalPackages: ["googleapis", "@google-cloud/local-auth"],
};

export default nextConfig;
