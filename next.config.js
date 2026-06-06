export default {
  images: { unoptimized: true },
  output: "export",
  // The GitHub Pages project subpath (basePath/assetPrefix) is injected at
  // deploy time by actions/configure-pages (static_site_generator: next), so it
  // isn't hardcoded here. The OAuth redirect and the query-string router read
  // window.location, so they pick up whatever basePath is live.
};
