import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  // Relative, so the build does not have to know where it will be served from: GitHub Pages puts a
  // project site under the repository's name, and a custom domain puts it back at the root.
  base: "./",
  // Bound to every interface so other machines on the same network can reach it. 8889 because that
  // is the port this host's firewall already lets through; the default 4173 is not.
  // strictPort so a taken port is an error rather than a silent move to one the firewall blocks.
  server: { host: true, port: 8889, strictPort: true },
  preview: { host: true, port: 8889, strictPort: true },
  // The engine pulls in chalk purely for its terminal board dump, which drags
  // node:tty into the bundle; the trainer renders to canvas instead.
  resolve: {
    alias: { chalk: fileURLToPath(new URL("src/chalk.ts", import.meta.url)) }
  }
});
