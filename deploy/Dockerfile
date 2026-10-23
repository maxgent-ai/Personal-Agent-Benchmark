# Replay service image: whistle + the replay plugin. Mount one task directory (tasks/<id>/ from
# this repository) at /task; the recording is unpacked into $PAB_CACHE when the service starts.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY test ./test
COPY scripts ./scripts
RUN npx tsc -p tsconfig.json

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PAB_CACHE=/cache
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY bin ./bin
COPY plugins ./plugins
COPY sites ./sites
EXPOSE 8899
CMD ["node", "bin/pab.js", "serve", "/task", "--port", "8899", "--host", "0.0.0.0", "--log", "/logs/replay.jsonl"]
