# Image for running BeaverParty on SIPB Hyades (or anywhere with Docker).
FROM docker.io/library/node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER node
CMD ["node", "server/index.js"]
