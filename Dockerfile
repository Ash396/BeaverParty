# Image for running BeaverParty on SIPB Hyades (or anywhere with Docker).
FROM docker.io/library/node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts
# The SQLite database lives in /data. On Hyades, mount a volume there.
RUN mkdir /data && chown node:node /data
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/beaverparty.db
EXPOSE 3000
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
