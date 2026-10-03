import type { NextConfig } from "next";

// PROTOTYPE, throwaway. Pinned to this directory so Next does not climb to the repo's other lockfile.
const config: NextConfig = { turbopack: { root: __dirname } };
export default config;
