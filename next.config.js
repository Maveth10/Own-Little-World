/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['groq-sdk'],
  },
};

module.exports = nextConfig;