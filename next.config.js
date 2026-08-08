/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['groq-sdk'],
  },
  typescript: {
    // Ignoruje błędy typów podczas budowania na Vercel
    ignoreBuildErrors: true,
  },
  eslint: {
    // Ignoruje ostrzeżenia lintera podczas budowania na Vercel
    ignoreDuringBuilds: true,
  },
};

module.exports = nextConfig;