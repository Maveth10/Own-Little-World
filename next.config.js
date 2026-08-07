/** @type {import('next').NextConfig} */
const nextConfig = {
    // Wskazujemy Next.js, aby nie pakował tych bibliotek do bundla
    serverExternalPackages: ['@xenova/transformers', 'onnxruntime-node'],
    webpack: (config) => {
      // Ignorujemy natywny moduł binarny onnxruntime-node
      config.resolve.alias = {
        ...config.resolve.alias,
        'onnxruntime-node$': false,
      };
      return config;
    },
  };
  
  module.exports = nextConfig;