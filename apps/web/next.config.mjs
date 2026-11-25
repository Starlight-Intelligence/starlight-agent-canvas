/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@starlight-agent-canvas/core', '@starlight-agent-canvas/world'],
  allowedDevOrigins: ['127.0.0.1'],
};

export default nextConfig;
