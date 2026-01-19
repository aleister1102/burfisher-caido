import { defineConfig } from "@caido-community/dev";

export default defineConfig({
  id: "burfisher",
  name: "Burfisher",
  description: "Scan HTTP traffic for exposed secrets using MongoDB Kingfisher",
  version: "1.0.4",
  author: {
    name: "insomnia1102",
    url: "https://github.com/aleister1102/burfisher-caido",
  },
  plugins: [
    {
      kind: "frontend",
      id: "burfisher-frontend",
      name: "Burfisher UI",
      root: "./src/frontend",
      backend: {
        id: "burfisher-backend",
      },
    },
    {
      kind: "backend",
      id: "burfisher-backend",
      name: "Burfisher Backend",
      root: "./src/backend",
    },
  ],
});
