export default {
  images: { unoptimized: true },
  output: "export",
  // Served from a GitHub Pages project subpath in production; the dev server
  // stays at the root. The OAuth redirect and the query-string router both read
  // window.location, so they pick this up automatically.
  basePath: process.env.NODE_ENV === "production" ? "/subtube" : undefined,
};
