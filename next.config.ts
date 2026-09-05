import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  images: {
    unoptimized: true
  },
  //allow all origins
  allowedDevOrigins:["*"]
};

export default nextConfig;
