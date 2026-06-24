# Dockerfile so MCP registries/catalogs (e.g. Glama) can build, start, and
# introspect the server. The server lists its tools over stdio WITHOUT a token
# — HOOKSENSE_TOKEN is only needed to actually call a tool — so introspection
# checks pass with no credentials.
FROM node:20-alpine

WORKDIR /app

# Install deps (incl. devDeps for the TypeScript build) against the lockfile.
COPY package.json package-lock.json ./
RUN npm ci

# Build the server.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# stdio MCP server.
ENTRYPOINT ["node", "dist/index.js"]
