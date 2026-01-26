import { defineConfig } from "@caido-community/dev";

export default defineConfig({
  id: "kingfisher",
  name: "Kingfisher",
  description: "Scan HTTP traffic for exposed secrets using MongoDB Kingfisher",
  version: "1.0.6",
  author: {
    name: "insomnia1102",
    url: "https://github.com/aleister1102/kingfisher-caido",
  },
  plugins: [
    {
      kind: "frontend",
      id: "kingfisher-frontend",
      name: "Kingfisher UI",
      root: "./src/frontend",
      backend: {
        id: "kingfisher-backend",
      },
    },
    {
      kind: "backend",
      id: "kingfisher-backend",
      name: "Kingfisher Backend",
      root: "./src/backend",
    },
  ],
});
