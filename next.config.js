const withBundleAnalyzer = require('@next/bundle-analyzer')({
  enabled: process.env.ANALYZE === 'true',
  openAnalyzer: true, // 👈 IMPORTANT
});

module.exports = withBundleAnalyzer({
  reactStrictMode: true,
});