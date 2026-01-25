import { defineConfig } from "@caido-community/dev";

export default defineConfig({
  id: "caidofisher",
  name: "Caidofisher",
  description: "Scan HTTP traffic for exposed secrets using MongoDB Kingfisher",
  version: "1.0.4",
  author: {
    name: "insomnia1102",
    url: "https://github.com/aleister1102/caidofisher-caido",
  },
  plugins: [
    {
      kind: "frontend",
      id: "caidofisher-frontend",
      name: "Caidofisher UI",
      root: "./src/frontend",
      backend: {
        id: "caidofisher-backend",
      },
    },
    {
      kind: "backend",
      id: "caidofisher-backend",
      name: "Caidofisher Backend",
      root: "./src/backend",
    },
  ],
});
