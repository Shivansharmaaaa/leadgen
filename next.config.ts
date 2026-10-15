import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["postgres", "twilio"],
  // Webhook bodies must stay raw for signature verification; handled per-route.
  experimental: { optimizePackageImports: ["date-fns"] },
};

export default nextConfig;
